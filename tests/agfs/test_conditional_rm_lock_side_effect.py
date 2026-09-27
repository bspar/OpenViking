# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Conditional removal does not materialize missing ancestors in the native mount."""

import hashlib
import os

import pytest

from openviking.pyagfs import get_binding_client
from openviking.storage.viking_fs import init_viking_fs
from openviking.utils.agfs_utils import RagfsBindingConfig, create_agfs_client
from openviking_cli.exceptions import AbortedError, InvalidArgumentError
from openviking_cli.utils.config.agfs_config import AGFSConfig, AGFSPathLockConfig


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["filesystem", "memory"])
@pytest.mark.parametrize("recursive", [False, True])
async def test_conditional_missing_nested_file_leaves_native_tree_unchanged(
    tmp_path, provider, recursive
):
    try:
        get_binding_client()
    except ImportError:
        pytest.skip("native RAGFS binding is unavailable on this platform")

    config = AGFSConfig(
        path=str(tmp_path), backend="local", pathlock=AGFSPathLockConfig(provider=provider)
    )
    fs = init_viking_fs(agfs=create_agfs_client(RagfsBindingConfig(agfs=config)))
    await fs.mkdir("viking://resources", exist_ok=True)
    physical_root = tmp_path / "viking"

    def tree():
        return sorted(
            os.path.relpath(os.path.join(root, name), physical_root)
            for root, directories, files in os.walk(physical_root)
            for name in directories + files
        )

    before = tree()
    expected = InvalidArgumentError if recursive else AbortedError
    with pytest.raises(expected):
        await fs.rm(
            "viking://resources/new-dir/missing.md",
            recursive=recursive,
            expected_sha256=hashlib.sha256(b"reviewed bytes").hexdigest(),
        )
    assert tree() == before
    assert not await fs.exists("viking://resources/new-dir")
