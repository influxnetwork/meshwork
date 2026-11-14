// Reads the IPv4 neighbour table through the routing sysctl (NET_RT_FLAGS with RTF_LLINFO).
// macOS shows hardware addresses only to a process that holds the
// com.apple.developer.networking.topology-observation entitlement itself, so this runs inside the
// app's main process rather than in a child process.

#include "arp_table.h"

#include <arpa/inet.h>
#include <errno.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/route.h>
#include <netinet/if_ether.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/sysctl.h>

int write_arp_table(FILE *out) {
  int mib[6] = {CTL_NET, PF_ROUTE, 0, AF_INET, NET_RT_FLAGS, RTF_LLINFO};
  size_t len = 0;
  if (sysctl(mib, 6, NULL, &len, NULL, 0) < 0) return -1;
  if (len == 0) return 0;
  // The table can grow between the size query and the read; leave room for a few more entries.
  len += len / 4 + 1024;
  char *buf = malloc(len);
  if (!buf) return -1;
  if (sysctl(mib, 6, buf, &len, NULL, 0) < 0) {
    int saved = errno;
    free(buf);
    errno = saved;
    return -1;
  }
  for (char *p = buf; p + sizeof(struct rt_msghdr) <= buf + len;) {
    struct rt_msghdr *rtm = (struct rt_msghdr *)p;
    if (rtm->rtm_msglen == 0 || p + rtm->rtm_msglen > buf + len) break;
    char *end = p + rtm->rtm_msglen;
    p = end;
    // Each record holds the IPv4 address, then the link-layer address; skip one that is cut short.
    struct sockaddr_inarp *sin = (struct sockaddr_inarp *)(rtm + 1);
    if ((char *)sin + sizeof *sin > end) continue;
    struct sockaddr_dl *sdl = (struct sockaddr_dl *)((char *)sin + ((sin->sin_len + 3) & ~3));
    const size_t sdl_head = offsetof(struct sockaddr_dl, sdl_data);
    if ((char *)sdl + sdl_head > end || (char *)sdl + sdl->sdl_len > end || sdl->sdl_family != AF_LINK) continue;
    char ip[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof ip);
    char ifname[IF_NAMESIZE] = "?";
    if_indextoname(sdl->sdl_index, ifname);
    if (sdl->sdl_alen == 6 && sdl_head + sdl->sdl_nlen + sdl->sdl_alen <= sdl->sdl_len) {
      const unsigned char *m = (const unsigned char *)LLADDR(sdl);
      fprintf(out, "? (%s) at %x:%x:%x:%x:%x:%x on %s ifscope [ethernet]\n", ip, m[0], m[1], m[2], m[3], m[4], m[5], ifname);
    } else {
      fprintf(out, "? (%s) at (incomplete) on %s ifscope [ethernet]\n", ip, ifname);
    }
  }
  free(buf);
  return 0;
}
