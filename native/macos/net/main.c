// meshwork-net: network probes that work inside the App Sandbox (macOS).
//
//   meshwork-net trace <host> [maxHops] [queries] [waitSec]
//       ICMP traceroute over an unprivileged datagram socket. Writes the same text as
//       `traceroute -n -I`: a header line on stderr, then one line per hop on stdout, e.g.
//       " 1  10.0.0.1  1.234 ms  1.102 ms  *". Stops when the destination answers.
//
// The App Sandbox blocks the setuid system traceroute; an unprivileged ICMP socket is permitted.
// The neighbour table is read in the app's own process instead (arp_addon.c).

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/ip_icmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static unsigned short checksum(const void *data, int len) {
  const unsigned short *p = data;
  unsigned int sum = 0;
  for (; len > 1; len -= 2) sum += *p++;
  if (len) sum += *(const unsigned char *)p;
  sum = (sum >> 16) + (sum & 0xffff);
  sum += sum >> 16;
  return (unsigned short)~sum;
}

// Text that `traceroute` appends after a time for an unreachable reply; NULL when the
// destination itself answered.
static const char *unreach_flag(int code) {
  switch (code) {
    case ICMP_UNREACH_NET: return "!N";
    case ICMP_UNREACH_HOST: return "!H";
    case ICMP_UNREACH_PROTOCOL: return "!P";
    case ICMP_UNREACH_NEEDFRAG: return "!F";
    case ICMP_UNREACH_SRCFAIL: return "!S";
    case ICMP_UNREACH_FILTER_PROHIB: return "!X";
    case ICMP_UNREACH_HOST_PRECEDENCE: return "!V";
    case ICMP_UNREACH_PRECEDENCE_CUTOFF: return "!C";
    case ICMP_UNREACH_PORT: return NULL;
    default: return "!U";
  }
}

enum { R_NONE, R_HOP, R_DEST, R_UNREACH };

// Waits for the answer to the probe with sequence `seq` until `deadline`. Fills `from` and
// returns what kind of answer arrived; `code` receives the unreachable code.
static int await_reply(int fd, unsigned short seq, struct in_addr dst, double deadline, struct in_addr *from, int *code) {
  unsigned char buf[1500];
  for (;;) {
    double left = deadline - now_ms();
    if (left <= 0) return R_NONE;
    long left_us = (long)(left * 1000);
    if (left_us < 1000) left_us = 1000;
    struct timeval tv = {(time_t)(left_us / 1000000), (suseconds_t)(left_us % 1000000)};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    struct sockaddr_in src;
    socklen_t sl = sizeof src;
    ssize_t n = recvfrom(fd, buf, sizeof buf, 0, (struct sockaddr *)&src, &sl);
    if (n < 0) {
      if (errno == EINTR) continue;
      return R_NONE;
    }
    // Replies on this socket carry the IP header first.
    if (n < (ssize_t)sizeof(struct ip)) continue;
    int hl = (buf[0] & 0x0f) * 4;
    if (n < hl + ICMP_MINLEN) continue;
    struct icmp *icmp = (struct icmp *)(buf + hl);
    if (icmp->icmp_type == ICMP_ECHOREPLY) {
      if (ntohs(icmp->icmp_seq) != seq || src.sin_addr.s_addr != dst.s_addr) continue;
      *from = src.sin_addr;
      return R_DEST;
    }
    if (icmp->icmp_type == ICMP_TIMXCEED || icmp->icmp_type == ICMP_UNREACH) {
      // The error quotes our original IP header and the first 8 bytes of our echo request.
      if (n < hl + 8 + (ssize_t)sizeof(struct ip)) continue;
      struct ip *inner = &icmp->icmp_ip;
      int ihl = inner->ip_hl * 4;
      if (ihl < (int)sizeof(struct ip) || n < hl + 8 + ihl + 8) continue;
      struct icmp *orig = (struct icmp *)((unsigned char *)inner + ihl);
      if (inner->ip_p != IPPROTO_ICMP || inner->ip_dst.s_addr != dst.s_addr) continue;
      if (orig->icmp_type != ICMP_ECHO || ntohs(orig->icmp_seq) != seq) continue;
      *from = src.sin_addr;
      if (icmp->icmp_type == ICMP_TIMXCEED) return R_HOP;
      *code = icmp->icmp_code;
      return unreach_flag(*code) ? R_UNREACH : R_DEST;
    }
  }
}

static int trace(const char *host, int max_hops, int queries, int wait_sec) {
  struct addrinfo hints = {0}, *res = NULL;
  hints.ai_family = AF_INET;
  if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) {
    fprintf(stderr, "traceroute: unknown host %s\n", host);
    return 1;
  }
  struct in_addr dst = ((struct sockaddr_in *)res->ai_addr)->sin_addr;
  freeaddrinfo(res);
  char dst_text[INET_ADDRSTRLEN];
  inet_ntop(AF_INET, &dst, dst_text, sizeof dst_text);
  fprintf(stderr, "traceroute to %s (%s), %d hops max, 48 byte packets\n", host, dst_text, max_hops);

  int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_ICMP);
  if (fd < 0) {
    fprintf(stderr, "traceroute: icmp socket: %s\n", strerror(errno));
    return 1;
  }
  struct sockaddr_in to = {0};
  to.sin_len = sizeof to;
  to.sin_family = AF_INET;
  to.sin_addr = dst;
  unsigned short id = (unsigned short)(getpid() & 0xffff);

  for (int ttl = 1; ttl <= max_hops; ttl++) {
    setsockopt(fd, IPPROTO_IP, IP_TTL, &ttl, sizeof ttl);
    printf("%2d ", ttl);
    struct in_addr last = {0};
    int reached = 0, unreachable = 0;
    for (int q = 0; q < queries; q++) {
      unsigned short seq = (unsigned short)(ttl * 16 + q);
      // 8-byte ICMP header plus 20 bytes of payload: 48 bytes on the wire with the IP header.
      unsigned char pkt[28] = {0};
      struct icmp *req = (struct icmp *)pkt;
      req->icmp_type = ICMP_ECHO;
      req->icmp_id = htons(id);
      req->icmp_seq = htons(seq);
      req->icmp_cksum = checksum(pkt, sizeof pkt);
      double sent = now_ms();
      if (sendto(fd, pkt, sizeof pkt, 0, (struct sockaddr *)&to, sizeof to) < 0) {
        printf(" *");
        fflush(stdout);
        continue;
      }
      struct in_addr from = {0};
      int code = 0;
      int kind = await_reply(fd, seq, dst, sent + wait_sec * 1000.0, &from, &code);
      if (kind == R_NONE) {
        printf(" *");
      } else {
        if (from.s_addr != last.s_addr) {
          char t[INET_ADDRSTRLEN];
          inet_ntop(AF_INET, &from, t, sizeof t);
          printf(" %s", t);
          last = from;
        }
        printf("  %.3f ms", now_ms() - sent);
        if (kind == R_UNREACH) {
          printf(" %s", unreach_flag(code));
          unreachable = 1;
        }
        if (kind == R_DEST) reached = 1;
      }
      fflush(stdout);
    }
    printf("\n");
    fflush(stdout);
    if (reached || unreachable) break;
  }
  close(fd);
  return 0;
}

static int bounded(const char *text, int fallback, int lo, int hi) {
  if (!text) return fallback;
  int v = atoi(text);
  return v < lo ? lo : v > hi ? hi : v;
}

int main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "trace") == 0)
    return trace(argv[2], bounded(argc > 3 ? argv[3] : NULL, 30, 1, 64), bounded(argc > 4 ? argv[4] : NULL, 3, 1, 10),
                 bounded(argc > 5 ? argv[5] : NULL, 1, 1, 10));
  fprintf(stderr, "usage: meshwork-net trace <host> [maxHops] [queries] [waitSec]\n");
  return 2;
}
