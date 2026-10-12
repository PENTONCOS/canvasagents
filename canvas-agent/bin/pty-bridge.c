#define _DARWIN_C_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <signal.h>
#include <util.h>
#include <errno.h>

int main(int argc, char **argv) {
  if (argc < 5 || strcmp(argv[3], "--") != 0) {
    fprintf(stderr, "usage: pty-bridge cols rows -- cmd [args...]\n");
    return 2;
  }
  int cols = atoi(argv[1]), rows = atoi(argv[2]);
  char **cmd = &argv[4];

  struct winsize ws; memset(&ws, 0, sizeof ws);
  ws.ws_col = (unsigned short)cols; ws.ws_row = (unsigned short)rows;
  int master;
  pid_t pid = forkpty(&master, NULL, NULL, &ws);
  if (pid < 0) { perror("forkpty"); return 1; }
  if (pid == 0) {
    setenv("TERM", getenv("BRIDGE_TERM") ? getenv("BRIDGE_TERM") : "xterm-256color", 1);
    execvp(cmd[0], cmd);
    perror("execvp");
    _exit(127);
  }

  int ctrl_fd = 3;
  int ctrl_open = fcntl(ctrl_fd, F_GETFD) != -1;
  char buf[65536];
  for (;;) {
    fd_set rfds; FD_ZERO(&rfds);
    FD_SET(0, &rfds); FD_SET(master, &rfds);
    int maxfd = master;
    if (ctrl_open) { FD_SET(ctrl_fd, &rfds); if (ctrl_fd > maxfd) maxfd = ctrl_fd; }
    if (select(maxfd + 1, &rfds, NULL, NULL, NULL) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (FD_ISSET(0, &rfds)) {
      ssize_t n = read(0, buf, sizeof buf);
      if (n <= 0) break;               /* parent gone -> detach */
      ssize_t w = 0;
      while (w < n) { ssize_t k = write(master, buf + w, (size_t)(n - w)); if (k <= 0) break; w += k; }
    }
    if (ctrl_open && FD_ISSET(ctrl_fd, &rfds)) {
      ssize_t n = read(ctrl_fd, buf, sizeof buf - 1);
      if (n <= 0) { ctrl_open = 0; }
      else {
        buf[n] = 0;
        char *c = strstr(buf, "\"cols\""), *r = strstr(buf, "\"rows\"");
        if (c && r) {
          struct winsize w2; memset(&w2, 0, sizeof w2);
          w2.ws_col = (unsigned short)atoi(c + 7);
          w2.ws_row = (unsigned short)atoi(r + 7);
          ioctl(master, TIOCSWINSZ, &w2);
          kill(pid, SIGWINCH);
        }
      }
    }
    if (FD_ISSET(master, &rfds)) {
      ssize_t n = read(master, buf, sizeof buf);
      if (n <= 0) break;               /* child exited */
      ssize_t w = 0;
      while (w < n) { ssize_t k = write(1, buf + w, (size_t)(n - w)); if (k <= 0) break; w += k; }
    }
  }
  close(master);
  return 0;
}
