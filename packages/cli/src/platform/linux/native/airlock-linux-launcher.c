#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <linux/sched.h>
#include <seccomp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef O_PATH
#define O_PATH 010000000
#endif
#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif
/* Linux 5.19 UAPI; older distro headers (Ubuntu 22.04) omit the name. */
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif

#define AIRLOCK_LAUNCHER_FAILURE 125
#define AIRLOCK_MIN_LANDLOCK_ABI 2

static int fail_errno(const char *operation, const char *subject) {
  fprintf(stderr, "airlock-linux-launcher: %s %s: %s\n", operation,
          subject == NULL ? "" : subject, strerror(errno));
  return AIRLOCK_LAUNCHER_FAILURE;
}

static int fail_message(const char *message) {
  fprintf(stderr, "airlock-linux-launcher: %s\n", message);
  return AIRLOCK_LAUNCHER_FAILURE;
}

static int landlock_abi(void) {
  return (int)syscall(__NR_landlock_create_ruleset, NULL, 0,
                      LANDLOCK_CREATE_RULESET_VERSION);
}

static int add_landlock_path(int ruleset_fd, const char *path,
                             __u64 allowed_access, bool directory) {
  int flags = O_PATH | O_CLOEXEC | O_NOFOLLOW;
  if (directory) {
    flags |= O_DIRECTORY;
  }
  int path_fd = open(path, flags);
  if (path_fd < 0) {
    return fail_errno("open policy path", path);
  }

  struct stat status;
  if (fstat(path_fd, &status) != 0) {
    int saved = errno;
    close(path_fd);
    errno = saved;
    return fail_errno("stat policy path", path);
  }
  if ((directory && !S_ISDIR(status.st_mode)) ||
      (!directory && !S_ISREG(status.st_mode))) {
    close(path_fd);
    fprintf(stderr,
            "airlock-linux-launcher: policy path has unsupported type: %s\n",
            path);
    return AIRLOCK_LAUNCHER_FAILURE;
  }

  struct landlock_path_beneath_attr rule = {
      .allowed_access = allowed_access,
      .parent_fd = path_fd,
  };
  int result = (int)syscall(__NR_landlock_add_rule, ruleset_fd,
                            LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;
  close(path_fd);
  if (result != 0) {
    errno = saved;
    return fail_errno("add Landlock rule", path);
  }
  return 0;
}

static int install_landlock(char *const *allowed, size_t allowed_count) {
  int abi = landlock_abi();
  if (abi < AIRLOCK_MIN_LANDLOCK_ABI) {
    if (abi < 0) {
      return fail_errno("query Landlock ABI", NULL);
    }
    fprintf(stderr,
            "airlock-linux-launcher: Landlock ABI %d is below required ABI %d\n",
            abi, AIRLOCK_MIN_LANDLOCK_ABI);
    return AIRLOCK_LAUNCHER_FAILURE;
  }

  struct landlock_ruleset_attr ruleset = {
      .handled_access_fs = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_REFER,
  };
  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &ruleset,
                                sizeof(ruleset), 0);
  if (ruleset_fd < 0) {
    return fail_errno("create Landlock ruleset", NULL);
  }

  int result = add_landlock_path(ruleset_fd, "/", LANDLOCK_ACCESS_FS_REFER,
                                 true);
  for (size_t index = 0; result == 0 && index < allowed_count; index++) {
    result = add_landlock_path(ruleset_fd, allowed[index],
                               LANDLOCK_ACCESS_FS_EXECUTE, false);
  }
  if (result != 0) {
    close(ruleset_fd);
    return result;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    int saved = errno;
    close(ruleset_fd);
    errno = saved;
    return fail_errno("set no_new_privs", NULL);
  }
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    int saved = errno;
    close(ruleset_fd);
    errno = saved;
    return fail_errno("enforce Landlock ruleset", NULL);
  }
  close(ruleset_fd);
  return 0;
}

static int deny_syscall(scmp_filter_ctx filter, const char *name,
                        uint32_t action) {
  int syscall_number = seccomp_syscall_resolve_name(name);
  if (syscall_number == __NR_SCMP_ERROR) {
    return 0;
  }
  int result = seccomp_rule_add(filter, action, syscall_number, 0);
  if (result < 0) {
    errno = -result;
    return fail_errno("add seccomp rule", name);
  }
  return 0;
}

static int install_seccomp(void) {
  scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
  if (filter == NULL) {
    errno = ENOMEM;
    return fail_errno("create seccomp filter", NULL);
  }

  int result = seccomp_attr_set(filter, SCMP_FLTATR_CTL_NNP, 1);
  if (result < 0) {
    errno = -result;
    seccomp_release(filter);
    return fail_errno("configure seccomp no_new_privs", NULL);
  }

  static const char *const denied[] = {
      /* No socket family, including loopback, Unix, netlink, or socketpair. */
      "socket",          "socketpair",       "connect",
      "bind",            "listen",           "accept",
      "accept4",         "sendto",           "sendmsg",
      "sendmmsg",        "recvfrom",         "recvmsg",
      "recvmmsg",        "shutdown",         "getsockname",
      "getpeername",     "setsockopt",       "getsockopt",
      /* No anonymous or descriptor-mediated executable authority. */
      "memfd_create",    "execveat",         "pidfd_getfd",
      /* No namespace or mount-policy changes after Bubblewrap setup. */
      "unshare",         "setns",            "mount",
      "umount2",         "pivot_root",       "chroot",
      "fsopen",          "fsconfig",         "fsmount",
      "fspick",          "open_tree",        "move_mount",
      "mount_setattr",
      /* No cross-process or privileged kernel control channels. */
      "ptrace",          "process_vm_readv", "process_vm_writev",
      "bpf",             "perf_event_open",  "add_key",
      "request_key",     "keyctl",           "userfaultfd",
      "kexec_load",      "kexec_file_load",  "init_module",
      "finit_module",    "delete_module",
      /* Block asynchronous syscall paths that can bypass argument filters. */
      "io_uring_setup",  "io_uring_enter",   "io_uring_register",
  };
  for (size_t index = 0;
       result >= 0 && index < sizeof(denied) / sizeof(denied[0]); index++) {
    int added = deny_syscall(filter, denied[index], SCMP_ACT_ERRNO(EPERM));
    if (added != 0) {
      seccomp_release(filter);
      return added;
    }
  }

  int clone3_number = seccomp_syscall_resolve_name("clone3");
  if (clone3_number != __NR_SCMP_ERROR) {
    result = seccomp_rule_add(filter, SCMP_ACT_ERRNO(ENOSYS), clone3_number, 0);
    if (result < 0) {
      errno = -result;
      seccomp_release(filter);
      return fail_errno("add seccomp rule", "clone3");
    }
  }

  int clone_number = seccomp_syscall_resolve_name("clone");
  static const uint64_t namespace_flags[] = {
      CLONE_NEWCGROUP, CLONE_NEWIPC,  CLONE_NEWNET,  CLONE_NEWNS,
      CLONE_NEWPID,    CLONE_NEWTIME, CLONE_NEWUSER, CLONE_NEWUTS,
  };
  if (clone_number != __NR_SCMP_ERROR) {
    for (size_t index = 0;
         index < sizeof(namespace_flags) / sizeof(namespace_flags[0]); index++) {
      result = seccomp_rule_add(
          filter, SCMP_ACT_ERRNO(EPERM), clone_number, 1,
          SCMP_A0(SCMP_CMP_MASKED_EQ, namespace_flags[index],
                  namespace_flags[index]));
      if (result < 0) {
        errno = -result;
        seccomp_release(filter);
        return fail_errno("add seccomp namespace-clone rule", NULL);
      }
    }
  }

  result = seccomp_load(filter);
  if (result < 0) {
    errno = -result;
    seccomp_release(filter);
    return fail_errno("load seccomp filter", NULL);
  }
  seccomp_release(filter);
  return 0;
}

static int validate_stdio(bool allow_memfd_stdin) {
  for (int descriptor = STDIN_FILENO; descriptor <= STDERR_FILENO;
       descriptor++) {
    struct stat status;
    if (fstat(descriptor, &status) != 0) {
      return fail_errno("inspect contained stdio", NULL);
    }
    /*
     * Bun implements captured pipes with local socketpairs and explicit byte
     * stdin with an anonymous memfd. Cell rejects every inherited stdio mode
     * before ProcessRunner creates these descriptors. The backend opts in to
     * that one regular descriptor, and F_GET_SEALS distinguishes it from an
     * ambient filesystem file. Other regular files bypassed the Cell boundary.
     */
    bool runtime_stdin = descriptor == STDIN_FILENO && allow_memfd_stdin &&
                         S_ISREG(status.st_mode) &&
                         fcntl(descriptor, F_GET_SEALS) >= 0;
    if ((!runtime_stdin && S_ISREG(status.st_mode)) ||
        S_ISDIR(status.st_mode) || S_ISBLK(status.st_mode)) {
      fprintf(stderr,
              "airlock-linux-launcher: contained stdio fd %d has unsafe type\n",
              descriptor);
      return AIRLOCK_LAUNCHER_FAILURE;
    }
  }
  return 0;
}

static int close_extra_descriptors(void) {
#ifdef __NR_close_range
  if (syscall(__NR_close_range, 3U, ~0U, CLOSE_RANGE_UNSHARE) == 0) {
    return 0;
  }
  if (errno != ENOSYS) {
    return fail_errno("close inherited descriptors", NULL);
  }
#endif
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) {
    return fail_errno("read descriptor limit", NULL);
  }
  rlim_t maximum = limit.rlim_cur == RLIM_INFINITY ? 1048576 : limit.rlim_cur;
  for (int descriptor = 3; (rlim_t)descriptor < maximum; descriptor++) {
    close(descriptor);
  }
  return 0;
}

static int probe(void) {
  int abi = landlock_abi();
  if (abi < AIRLOCK_MIN_LANDLOCK_ABI) {
    if (abi < 0) {
      return fail_errno("query Landlock ABI", NULL);
    }
    fprintf(stderr,
            "airlock-linux-launcher: Landlock ABI %d is below required ABI %d\n",
            abi, AIRLOCK_MIN_LANDLOCK_ABI);
    return AIRLOCK_LAUNCHER_FAILURE;
  }
  int secured = install_seccomp();
  if (secured != 0) {
    return secured;
  }
  printf("airlock-linux-launcher-v1 landlock-abi=%d seccomp=1\n", abi);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    return probe();
  }

  char **allowed = calloc((size_t)argc, sizeof(char *));
  char **environment = calloc((size_t)argc + 1, sizeof(char *));
  if (allowed == NULL || environment == NULL) {
    free(allowed);
    free(environment);
    errno = ENOMEM;
    return fail_errno("allocate launcher policy", NULL);
  }

  size_t allowed_count = 0;
  size_t environment_count = 0;
  bool allow_memfd_stdin = false;
  int cursor = 1;
  while (cursor < argc && strcmp(argv[cursor], "--") != 0) {
    if (strcmp(argv[cursor], "--allow-memfd-stdin") == 0 &&
        !allow_memfd_stdin) {
      allow_memfd_stdin = true;
      cursor++;
      continue;
    }
    if (strcmp(argv[cursor], "--allow-exec") == 0 && cursor + 1 < argc) {
      allowed[allowed_count++] = argv[cursor + 1];
      cursor += 2;
      continue;
    }
    if (strcmp(argv[cursor], "--env") == 0 && cursor + 2 < argc) {
      const char *name = argv[cursor + 1];
      const char *value = argv[cursor + 2];
      if (name[0] == '\0' || strchr(name, '=') != NULL) {
        free(allowed);
        free(environment);
        return fail_message("invalid target environment name");
      }
      size_t length = strlen(name) + strlen(value) + 2;
      environment[environment_count] = malloc(length);
      if (environment[environment_count] == NULL) {
        free(allowed);
        for (size_t index = 0; index < environment_count; index++) {
          free(environment[index]);
        }
        free(environment);
        errno = ENOMEM;
        return fail_errno("allocate target environment", NULL);
      }
      snprintf(environment[environment_count], length, "%s=%s", name, value);
      environment_count++;
      cursor += 3;
      continue;
    }
    free(allowed);
    for (size_t index = 0; index < environment_count; index++) {
      free(environment[index]);
    }
    free(environment);
    return fail_message("invalid launcher arguments");
  }

  if (cursor >= argc || cursor + 1 >= argc || allowed_count == 0) {
    free(allowed);
    for (size_t index = 0; index < environment_count; index++) {
      free(environment[index]);
    }
    free(environment);
    return fail_message("missing executable policy or target command");
  }
  cursor++;
  environment[environment_count] = NULL;

  int result = validate_stdio(allow_memfd_stdin);
  if (result == 0) {
    result = install_landlock(allowed, allowed_count);
  }
  if (result == 0) {
    result = install_seccomp();
  }
  if (result == 0) {
    result = close_extra_descriptors();
  }
  if (result != 0) {
    free(allowed);
    for (size_t index = 0; index < environment_count; index++) {
      free(environment[index]);
    }
    free(environment);
    return result;
  }

  execve(argv[cursor], &argv[cursor], environment);
  result = fail_errno("exec target", argv[cursor]);
  free(allowed);
  for (size_t index = 0; index < environment_count; index++) {
    free(environment[index]);
  }
  free(environment);
  return result;
}
