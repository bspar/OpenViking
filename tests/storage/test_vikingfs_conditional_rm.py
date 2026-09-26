# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Conditional VikingFS deletion keeps the reviewed content under one lease."""

import asyncio
import hashlib
from unittest.mock import AsyncMock

import pytest

from openviking.server.identity import RequestContext, Role
from openviking.storage.viking_fs import VikingFS
from openviking_cli.exceptions import AbortedError, InvalidArgumentError
from openviking_cli.session.user_id import UserIdentifier


class _ConditionalDeleteAGFS:
    """In-memory AGFS double that enforces automatic exact-path write locks."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.directories: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._lease_paths: dict[str, str] = {}
        self._next_lease = 0
        self.stat_calls: list[str] = []
        self.writer_waiting = asyncio.Event()
        self.conditional_read_entered = asyncio.Event()
        self.release_conditional_read = asyncio.Event()
        self.pause_conditional_read = False
        self.missing_stat_entered = asyncio.Event()
        self.release_missing_stat = asyncio.Event()
        self.pause_missing_stat = False

    def _lock_for(self, path: str) -> asyncio.Lock:
        return self._locks.setdefault(path, asyncio.Lock())

    async def ensure_parent_dirs(self, path: str, fs_ctx=None) -> None:
        del path, fs_ctx

    async def ls(self, path: str, **kwargs):
        del path, kwargs
        return []

    async def stat(self, path: str):
        self.stat_calls.append(path)
        if path in self.files:
            return {"isDir": False}
        if path in self.directories:
            return {"isDir": True}
        if self.pause_missing_stat:
            self.missing_stat_entered.set()
            await self.release_missing_stat.wait()
        raise FileNotFoundError(path)

    async def pathlock_acquire_exact(self, path: str):
        await self._lock_for(path).acquire()
        self._next_lease += 1
        lease_ref = f"lease-{self._next_lease}"
        self._lease_paths[lease_ref] = path
        return {"lease_ref": lease_ref}

    async def pathlock_acquire_tree(self, path: str):
        return await self.pathlock_acquire_exact(path)

    async def pathlock_release(self, lease) -> None:
        lease_ref = lease["lease_ref"]
        path = self._lease_paths.pop(lease_ref)
        self._lock_for(path).release()

    async def read(self, path: str, fs_ctx=None) -> bytes:
        if self.pause_conditional_read and fs_ctx and fs_ctx.get("lease_ref"):
            self.conditional_read_entered.set()
            await self.release_conditional_read.wait()
        return self.files[path]

    async def write(self, path: str, content: bytes, fs_ctx=None, auto_pathlock=True) -> None:
        if auto_pathlock and not fs_ctx:
            self.writer_waiting.set()
            async with self._lock_for(path):
                self.files[path] = content
            return
        self.files[path] = content

    async def rm(self, path: str, recursive=False, fs_ctx=None, auto_pathlock=True):
        del recursive, fs_ctx, auto_pathlock
        self.files.pop(path, None)
        self.directories.discard(path)
        return {}


@pytest.fixture
def conditional_rm_env():
    """Return VikingFS, its lock-aware AGFS double, and a root request context."""
    backend = _ConditionalDeleteAGFS()
    vector_store = AsyncMock()
    vector_store.count = AsyncMock(return_value=0)
    vector_store.delete_uris = AsyncMock()
    vector_store.delete = AsyncMock()
    viking_fs = VikingFS(agfs=object(), vector_store=vector_store)
    viking_fs._async_agfs = backend
    ctx = RequestContext(user=UserIdentifier.the_default_user(), role=Role(Role.ROOT))
    return viking_fs, backend, vector_store, ctx


@pytest.mark.asyncio
async def test_rm_deletes_file_when_reviewed_sha256_matches(conditional_rm_env):
    viking_fs, _backend, _vector_store, ctx = conditional_rm_env
    uri = "viking://resources/reviewed.md"
    await viking_fs.write_file(uri, b"reviewed bytes", ctx=ctx)

    digest = hashlib.sha256(b"reviewed bytes").hexdigest()
    result = await viking_fs.rm(uri, ctx=ctx, expected_sha256=digest)

    assert result["estimated_deleted_count"] >= 0
    assert not await viking_fs.exists(uri, ctx=ctx)


@pytest.mark.asyncio
async def test_rm_keeps_changed_file_and_vector_records_when_sha256_mismatches(conditional_rm_env):
    viking_fs, _backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/changed.md"
    await viking_fs.write_file(uri, b"changed bytes", ctx=ctx)

    with pytest.raises(AbortedError, match="content changed"):
        await viking_fs.rm(
            uri,
            ctx=ctx,
            expected_sha256=hashlib.sha256(b"old bytes").hexdigest(),
        )

    assert await viking_fs.read_file_bytes(uri, ctx=ctx) == b"changed bytes"
    vector_store.delete.assert_not_awaited()
    vector_store.delete_uris.assert_not_awaited()


@pytest.mark.asyncio
async def test_rm_rejects_uppercase_expected_sha256_before_side_effects(conditional_rm_env):
    viking_fs, backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/uppercase.md"

    with pytest.raises(InvalidArgumentError, match="64 lowercase hexadecimal"):
        await viking_fs.rm(uri, ctx=ctx, expected_sha256="A" * 64)

    assert backend.stat_calls == []
    vector_store.delete_uris.assert_not_awaited()


@pytest.mark.asyncio
async def test_rm_rejects_short_expected_sha256_before_side_effects(conditional_rm_env):
    viking_fs, backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/short.md"

    with pytest.raises(InvalidArgumentError, match="64 lowercase hexadecimal"):
        await viking_fs.rm(uri, ctx=ctx, expected_sha256="abc")

    assert backend.stat_calls == []
    vector_store.delete_uris.assert_not_awaited()


@pytest.mark.asyncio
async def test_rm_rejects_conditional_delete_of_directory(conditional_rm_env):
    viking_fs, backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/directory"
    backend.directories.add(viking_fs._uri_to_path(uri, ctx=ctx))

    with pytest.raises(InvalidArgumentError, match="only supports non-directory files"):
        await viking_fs.rm(
            uri,
            ctx=ctx,
            recursive=True,
            expected_sha256=hashlib.sha256(b"directory").hexdigest(),
        )

    vector_store.delete_uris.assert_not_awaited()


@pytest.mark.asyncio
async def test_rm_rejects_recursive_conditional_delete_of_file(conditional_rm_env):
    viking_fs, _backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/recursive.md"
    await viking_fs.write_file(uri, b"reviewed bytes", ctx=ctx)

    with pytest.raises(InvalidArgumentError, match="only supports non-directory files"):
        await viking_fs.rm(
            uri,
            ctx=ctx,
            recursive=True,
            expected_sha256=hashlib.sha256(b"reviewed bytes").hexdigest(),
        )

    vector_store.delete_uris.assert_not_awaited()


@pytest.mark.asyncio
async def test_rm_holds_conditional_delete_lease_until_writer_can_proceed(conditional_rm_env):
    viking_fs, backend, _vector_store, ctx = conditional_rm_env
    uri = "viking://resources/lease.md"
    await viking_fs.write_file(uri, b"reviewed bytes", ctx=ctx)
    backend.pause_conditional_read = True
    backend.writer_waiting.clear()

    delete_task = asyncio.create_task(
        viking_fs.rm(
            uri,
            ctx=ctx,
            expected_sha256=hashlib.sha256(b"reviewed bytes").hexdigest(),
        )
    )
    await asyncio.wait_for(backend.conditional_read_entered.wait(), timeout=1)

    writer_task = asyncio.create_task(viking_fs.write_file(uri, b"changed bytes", ctx=ctx))
    await asyncio.wait_for(backend.writer_waiting.wait(), timeout=1)
    assert not writer_task.done()

    backend.release_conditional_read.set()
    await delete_task
    await writer_task

    assert await viking_fs.read_file_bytes(uri, ctx=ctx) == b"changed bytes"


@pytest.mark.asyncio
async def test_rm_keeps_conditional_delete_lease_when_auto_pathlock_is_disabled(
    conditional_rm_env,
):
    viking_fs, backend, _vector_store, ctx = conditional_rm_env
    uri = "viking://resources/no-auto-lock.md"
    await viking_fs.write_file(uri, b"reviewed bytes", ctx=ctx)
    backend.pause_conditional_read = True

    delete_task = asyncio.create_task(
        viking_fs.rm(
            uri,
            ctx=ctx,
            auto_pathlock=False,
            expected_sha256=hashlib.sha256(b"reviewed bytes").hexdigest(),
        )
    )

    await asyncio.wait_for(backend.conditional_read_entered.wait(), timeout=1)
    backend.release_conditional_read.set()
    await delete_task


@pytest.mark.asyncio
async def test_rm_rejects_absent_conditional_target_without_vector_cleanup(conditional_rm_env):
    viking_fs, backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/missing.md"

    with pytest.raises(AbortedError, match="content changed"):
        await viking_fs.rm(
            uri,
            ctx=ctx,
            expected_sha256=hashlib.sha256(b"reviewed bytes").hexdigest(),
        )

    assert backend._next_lease == 1
    vector_store.delete_uris.assert_not_awaited()


@pytest.mark.asyncio
async def test_rm_keeps_unconditional_missing_target_orphan_cleanup(conditional_rm_env):
    viking_fs, backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/unconditional-missing.md"

    result = await viking_fs.rm(uri, ctx=ctx)

    assert result["estimated_deleted_count"] == 0
    assert backend._next_lease == 0
    vector_store.delete_uris.assert_awaited_once_with(ctx, [uri])


@pytest.mark.asyncio
async def test_rm_rejects_recreated_conditional_target_without_vector_cleanup(
    conditional_rm_env,
):
    viking_fs, backend, vector_store, ctx = conditional_rm_env
    uri = "viking://resources/recreated.md"
    backend.pause_missing_stat = True
    backend.writer_waiting.clear()

    delete_task = asyncio.create_task(
        viking_fs.rm(
            uri,
            ctx=ctx,
            expected_sha256=hashlib.sha256(b"reviewed bytes").hexdigest(),
        )
    )
    await asyncio.wait_for(backend.missing_stat_entered.wait(), timeout=1)

    writer_task = asyncio.create_task(viking_fs.write_file(uri, b"recreated", ctx=ctx))
    await asyncio.wait_for(backend.writer_waiting.wait(), timeout=1)
    writer_completed_before_stat = writer_task.done()

    backend.release_missing_stat.set()
    with pytest.raises(AbortedError, match="content changed"):
        await delete_task
    await writer_task

    assert not writer_completed_before_stat
    assert await viking_fs.read_file_bytes(uri, ctx=ctx) == b"recreated"
    vector_store.delete_uris.assert_not_awaited()
