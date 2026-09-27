# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

import asyncio
import threading

import pytest

from openviking.pyagfs import AsyncAGFSClient
from openviking.storage.viking_vector_index_backend import _AsyncVectorAdapter


@pytest.mark.asyncio
async def test_non_creating_exact_lock_passes_account_context_and_lease_capability():
    calls = []

    class Binding:
        def pathlock_acquire_exact_without_parent_creation(self, *args):
            calls.append(args)
            return {"lease_ref": "owned"}

    owner = {"lease_ref": "outer"}
    client = AsyncAGFSClient(Binding())
    result = await client.pathlock_acquire_exact_without_parent_creation(
        "/local/acct/resources/target.md", owner_lease_ref=owner
    )

    assert result == {"lease_ref": "owned"}
    assert calls == [({"account_id": "acct"}, "/local/acct/resources/target.md", 0.0, owner)]


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["agfs", "vector"])
async def test_async_agfs_client_hides_threadpool(backend):
    """Cancellation settles physical writes before cleanup may remove their data."""
    started, release = threading.Event(), threading.Event()
    writes = []

    class Writer:
        def write(self, path, data, **kwargs):
            started.set()
            if not release.wait(timeout=5):
                raise TimeoutError("Test did not release the write")
            writes.append((path, data))

    writer = Writer()
    operation = asyncio.create_task(
        AsyncAGFSClient(writer).write("/local/account/file", b"data")
        if backend == "agfs"
        else _AsyncVectorAdapter(writer).call("write", "record", b"data")
    )
    try:
        assert await asyncio.to_thread(started.wait, 5)
        operation.cancel()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not operation.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await operation
    assert len(writes) == 1
