"""
Minimal stand-in for the `genlayer` runtime module.

There is no pip-installable `genlayer`, so the only way to exercise the
contract's deterministic logic off-chain is to inject a stub into `sys.modules`
before importing it. This covers exactly the surface `contracts/stake_your_word.py`
touches at import time plus the pure helpers — nothing more. Anything that would
actually reach a node (web fetches, prompts, consensus) raises loudly, so a test
can never quietly pass by pretending to do non-deterministic work.
"""

import sys
import types


class UserError(Exception):
    """Stands in for gl.vm.UserError — the revert type the contract raises."""


class Return:
    """Stands in for gl.vm.Return, the wrapper around a leader's result."""

    def __init__(self, calldata):
        self.calldata = calldata


class _Generic:
    """Base for the subscriptable storage generics (DynArray[T], TreeMap[K, V])."""

    def __class_getitem__(cls, item):
        return cls


class DynArray(list, _Generic):
    pass


class TreeMap(dict, _Generic):
    """`get_or_insert_default` is the storage API the contract relies on —
    DynArray()/Struct() cannot be constructed directly on-chain."""

    default_factory = None

    def get_or_insert_default(self, key):
        if key not in self:
            self[key] = DynArray() if TreeMap.default_factory is None else TreeMap.default_factory()
        return self[key]


class Address:
    def __init__(self, value):
        if not isinstance(value, str) or not value.startswith("0x") or len(value) != 42:
            raise ValueError("bad address: %r" % (value,))
        self.value = value

    def __str__(self):
        return self.value

    def __eq__(self, other):
        return isinstance(other, Address) and other.value.lower() == self.value.lower()

    def __hash__(self):
        return hash(self.value.lower())


def _identity(fn):
    return fn


def _unreachable(*_args, **_kwargs):
    raise AssertionError(
        "non-deterministic call reached in an offline test — these helpers are "
        "supposed to be pure"
    )


class _Contract:
    pass


def build_module():
    """Assemble the fake `genlayer` module and register it in sys.modules."""
    gl = types.SimpleNamespace()

    gl.vm = types.SimpleNamespace(
        UserError=UserError,
        Return=Return,
        run_nondet=_unreachable,
        run_nondet_unsafe=_unreachable,
    )
    gl.nondet = types.SimpleNamespace(
        exec_prompt=_unreachable,
        web=types.SimpleNamespace(get=_unreachable, render=_unreachable),
    )
    gl.evm = types.SimpleNamespace(contract_interface=_identity)
    gl.eq_principle = types.SimpleNamespace(
        prompt_comparative=_unreachable,
        prompt_non_comparative=_unreachable,
        strict_eq=_unreachable,
    )

    write = _identity
    write.payable = _identity
    gl.public = types.SimpleNamespace(write=write, view=_identity)

    gl.message = types.SimpleNamespace(
        sender_address=Address("0x" + "11" * 20),
        contract_address=Address("0x" + "22" * 20),
        origin_address=Address("0x" + "11" * 20),
        value=0,
        chain_id=61999,
    )
    gl.message_raw = {"datetime": "2026-08-06T12:00:00Z"}
    gl.Contract = _Contract
    gl.storage = types.SimpleNamespace(copy_to_memory=_identity)

    module = types.ModuleType("genlayer")
    module.gl = gl
    module.Address = Address
    module.DynArray = DynArray
    module.TreeMap = TreeMap
    module.allow_storage = _identity
    # Storage int types are plain ints off-chain; the contract only relies on
    # them being callable and usable as annotations.
    for name in ("u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64"):
        setattr(module, name, int)
    module.__all__ = [
        "gl",
        "Address",
        "DynArray",
        "TreeMap",
        "allow_storage",
        "u8",
        "u16",
        "u32",
        "u64",
        "u128",
        "u256",
        "i8",
        "i16",
        "i32",
        "i64",
    ]

    sys.modules["genlayer"] = module
    return module
