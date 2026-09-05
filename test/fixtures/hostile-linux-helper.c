#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/sched.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

static int write_marker(const char *path, const char *text) {
  int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (descriptor < 0) return -1;
  size_t length = strlen(text);
  ssize_t written = write(descriptor, text, length);
  int saved = errno;
  close(descriptor);
  errno = saved;
  return written == (ssize_t)length ? 0 : -1;
}

#ifdef AIRLOCK_PRELOAD_LIBRARY
__attribute__((constructor)) static void record_preload(void) {
  const char *outside = getenv("AIRLOCK_PRELOAD_OUTSIDE");
  const char *private_marker = getenv("AIRLOCK_PRELOAD_PRIVATE");
  if (outside != NULL) {
    (void)write_marker(outside, "preload escaped\n");
  }
  if (private_marker != NULL) {
    (void)write_marker(private_marker, "preload contained\n");
  }
}
#else

static int expected_failure(long result, int expected, const char *operation) {
  if (result == -1 && errno == expected) return 0;
  fprintf(stderr, "%s: expected errno %d, observed result %ld errno %d\n",
          operation, expected, result, errno);
  return 1;
}

static int probe_socket(int family) {
  errno = 0;
  long result = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (result >= 0) close((int)result);
  return expected_failure(result, EPERM, "socket");
}

static int probe_socketpair(void) {
  int descriptors[2] = {-1, -1};
  errno = 0;
  long result = socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, descriptors);
  if (result == 0) {
    close(descriptors[0]);
    close(descriptors[1]);
  }
  return expected_failure(result, EPERM, "socketpair");
}

static int probe_memfd(void) {
#ifdef __NR_memfd_create
  errno = 0;
  long result = syscall(__NR_memfd_create, "airlock-hostile", 0U);
  if (result >= 0) close((int)result);
  return expected_failure(result, EPERM, "memfd_create");
#else
  return 77;
#endif
}

static int probe_clone3(void) {
#ifdef __NR_clone3
  struct clone_args arguments;
  memset(&arguments, 0, sizeof(arguments));
  arguments.exit_signal = SIGCHLD;
  errno = 0;
  long result = syscall(__NR_clone3, &arguments, sizeof(arguments));
  if (result == 0) _exit(0);
  if (result > 0) {
    (void)kill((pid_t)result, SIGKILL);
  }
  return expected_failure(result, ENOSYS, "clone3");
#else
  return 77;
#endif
}

static int probe_unshare(void) {
  errno = 0;
  long result = unshare(CLONE_NEWUSER);
  return expected_failure(result, EPERM, "unshare");
}

static int probe_openat2(const char *path) {
#ifdef __NR_openat2
  struct open_how how;
  memset(&how, 0, sizeof(how));
  how.flags = O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC;
  how.mode = 0600;
  errno = 0;
  int descriptor = (int)syscall(__NR_openat2, AT_FDCWD, path, &how, sizeof(how));
  if (descriptor < 0) {
    perror("openat2");
    return 1;
  }
  const char value[] = "openat2 allowed\n";
  ssize_t written = write(descriptor, value, sizeof(value) - 1U);
  int saved = errno;
  close(descriptor);
  errno = saved;
  return written == (ssize_t)(sizeof(value) - 1U) ? 0 : 1;
#else
  (void)path;
  return 77;
#endif
}

static int probe_truncate_denied(const char *path) {
  errno = 0;
  int descriptor = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC);
  if (descriptor >= 0) close(descriptor);
  if (descriptor == -1 && (errno == EROFS || errno == EACCES || errno == EPERM)) {
    return 0;
  }
  fprintf(stderr, "truncate: expected a write-fence error, observed fd %d errno %d\n",
          descriptor, errno);
  return 1;
}

static int probe_direct_exec_denied(const char *executable, const char *marker) {
  char *const arguments[] = {(char *)executable, (char *)marker, NULL};
  char *const environment[] = {NULL};
  errno = 0;
  execve(executable, arguments, environment);
  return expected_failure(-1, EACCES, "direct execve");
}

static int invoke_loader(const char *loader, const char *executable,
                         const char *marker) {
  char *const arguments[] = {(char *)loader, (char *)executable, (char *)marker,
                             NULL};
  char *const environment[] = {NULL};
  execve(loader, arguments, environment);
  perror("exec loader");
  return 1;
}

static int probe_extra_descriptors(void) {
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return 1;
  rlim_t maximum = limit.rlim_cur == RLIM_INFINITY ? 1048576 : limit.rlim_cur;
  if (maximum > 1048576) maximum = 1048576;
  for (int descriptor = 3; (rlim_t)descriptor < maximum; descriptor++) {
    errno = 0;
    if (fcntl(descriptor, F_GETFD) != -1 || errno != EBADF) {
      fprintf(stderr, "unexpected inherited descriptor: %d\n", descriptor);
      return 1;
    }
  }

  /*
   * Bubblewrap is PID 1 inside the fresh namespace. A retained --bind-fd
   * source there could be reopened through procfs and used as an openat escape
   * anchor even though the target's own descriptor table is clean. Version
   * 0.12 closes setup descriptors before forking PID 1; only its anonymous
   * lifecycle eventfd may remain above stderr.
   */
  for (int descriptor = 3; descriptor < 1024; descriptor++) {
    char path[64];
    char target[4096];
    int rendered = snprintf(path, sizeof(path), "/proc/1/fd/%d", descriptor);
    if (rendered < 0 || (size_t)rendered >= sizeof(path)) return 1;
    errno = 0;
    ssize_t length = readlink(path, target, sizeof(target) - 1U);
    if (length < 0) {
      if (errno == ENOENT || errno == EBADF || errno == EACCES ||
          errno == EPERM) {
        continue;
      }
      perror("read Bubblewrap PID 1 descriptor");
      return 1;
    }
    target[length] = '\0';
    if (strcmp(target, "anon_inode:[eventfd]") != 0) {
      fprintf(stderr, "unexpected Bubblewrap PID 1 descriptor %d: %s\n",
              descriptor, target);
      return 1;
    }
  }
  return 0;
}

static void sleep_millis(long milliseconds) {
  struct timespec request = {
      .tv_sec = milliseconds / 1000,
      .tv_nsec = (milliseconds % 1000) * 1000000,
  };
  while (nanosleep(&request, &request) != 0 && errno == EINTR) {
  }
}

static int daemonize_marker(const char *path) {
  pid_t child = fork();
  if (child < 0) return 1;
  if (child > 0) {
    /* Keep the namespace's owned root alive so the supervisor timeout, rather
     * than normal root exit, is what must tear down the detached grandchild. */
    sleep_millis(5000);
    return 0;
  }
  if (setsid() < 0) _exit(2);
  pid_t grandchild = fork();
  if (grandchild < 0) _exit(3);
  if (grandchild > 0) _exit(0);
  sleep_millis(1500);
  _exit(write_marker(path, "daemon survived\n") == 0 ? 0 : 4);
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "socket") == 0) {
    return probe_socket(strcmp(argv[2], "unix") == 0 ? AF_UNIX : AF_INET);
  }
  if (argc == 2 && strcmp(argv[1], "socketpair") == 0) {
    return probe_socketpair();
  }
  if (argc == 2 && strcmp(argv[1], "memfd") == 0) return probe_memfd();
  if (argc == 2 && strcmp(argv[1], "clone3") == 0) return probe_clone3();
  if (argc == 2 && strcmp(argv[1], "unshare") == 0) return probe_unshare();
  if (argc == 3 && strcmp(argv[1], "openat2") == 0) {
    return probe_openat2(argv[2]);
  }
  if (argc == 3 && strcmp(argv[1], "truncate-denied") == 0) {
    return probe_truncate_denied(argv[2]);
  }
  if (argc == 4 && strcmp(argv[1], "direct-exec-denied") == 0) {
    return probe_direct_exec_denied(argv[2], argv[3]);
  }
  if (argc == 5 && strcmp(argv[1], "loader-invocation") == 0) {
    return invoke_loader(argv[2], argv[3], argv[4]);
  }
  if (argc == 2 && strcmp(argv[1], "fd-check") == 0) {
    return probe_extra_descriptors();
  }
  if (argc == 3 && strcmp(argv[1], "daemonize-marker") == 0) {
    return daemonize_marker(argv[2]);
  }
  if (argc == 2 && strcmp(argv[1], "preload-target") == 0) return 0;

  fprintf(stderr,
          "usage: hostile-linux-helper socket FAMILY | socketpair | memfd | "
          "clone3 | unshare | openat2 PATH | truncate-denied PATH | "
          "direct-exec-denied EXEC MARKER | loader-invocation LOADER EXEC "
          "MARKER | fd-check | daemonize-marker PATH | preload-target\n");
  return 64;
}
#endif
