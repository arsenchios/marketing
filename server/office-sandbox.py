"""Linux converter launcher: no network, no app credentials, bounded resources.
The input/workspace is a private temporary directory created by the Node parent.
"""
import ctypes
import errno
import os
import resource
import sys

workdir, command, *args = sys.argv[1:]
os.chdir(workdir)
resource.setrlimit(resource.RLIMIT_CPU, (150, 160))
resource.setrlimit(resource.RLIMIT_FSIZE, (110 * 1024 * 1024, 110 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
# Railway's root process keeps application data inaccessible to the converter.
if os.geteuid() == 0:
    for root, dirs, files in os.walk(workdir):
        os.chown(root, 65534, 65534)
        for name in files:
            os.chown(os.path.join(root, name), 65534, 65534)
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)

class Arg(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint), ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
lib.seccomp_load.argtypes = [ctypes.c_void_p]
lib.seccomp_release.argtypes = [ctypes.c_void_p]
ctx = lib.seccomp_init(0x7FFF0000)  # allow by default
if not ctx:
    raise RuntimeError("Cannot isolate document conversion")
try:
    for family in (2, 10):  # IPv4 / IPv6; local Unix sockets used by LibreOffice stay available.
        if lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, lib.seccomp_syscall_resolve_name(b"socket"), 1, Arg(0, 4, family, 0)) != 0:
            raise RuntimeError("Cannot block converter network")
    for call in (b"ptrace", b"process_vm_readv", b"process_vm_writev"):
        number = lib.seccomp_syscall_resolve_name(call)
        if number >= 0 and lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0) != 0:
            raise RuntimeError("Cannot isolate converter process")
    if lib.seccomp_load(ctx) != 0:
        raise RuntimeError("Cannot install converter sandbox")
finally:
    lib.seccomp_release(ctx)
os.execvpe(command, [command, *args], {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": workdir, "TMPDIR": workdir, "LANG": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp"})
