#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

static int connect_tcp(const char *host, const char *port_text) {
  int descriptor = socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor < 0) return 70;

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)strtoul(port_text, NULL, 10));
  if (inet_pton(AF_INET, host, &address.sin_addr) != 1) return 71;
  if (connect(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(descriptor);
    return 72;
  }
  if (write(descriptor, "x", 1) != 1) {
    close(descriptor);
    return 73;
  }
  close(descriptor);
  return 0;
}

static int connect_unix(const char *path) {
  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) return 74;

  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) {
    close(descriptor);
    return 75;
  }
  strcpy(address.sun_path, path);
  if (connect(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(descriptor);
    return 76;
  }
  if (write(descriptor, "x", 1) != 1) {
    close(descriptor);
    return 77;
  }
  close(descriptor);
  return 0;
}

static int wait_with_child(void) {
  pid_t child = fork();
  if (child < 0) return 78;
  if (child == 0) {
    for (;;) pause();
  }

  printf("%d\n", child);
  fflush(stdout);
  for (;;) pause();
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "tcp-connect") == 0) {
    return connect_tcp(argv[2], argv[3]);
  }
  if (argc == 3 && strcmp(argv[1], "unix-connect") == 0) {
    return connect_unix(argv[2]);
  }
  if (argc == 2 && strcmp(argv[1], "wait-with-child") == 0) {
    return wait_with_child();
  }
  fprintf(stderr, "usage: hostile-macos-helper tcp-connect HOST PORT | unix-connect PATH | wait-with-child\n");
  return 64;
}
