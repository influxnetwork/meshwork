// Reads the kernel's IPv4 neighbour table (macOS).
#pragma once
#include <stdio.h>

// Writes one line per entry to `out`, in the same text as `arp -an`, e.g.
// "? (10.0.0.1) at a0:b1:c2:d3:e4:f5 on en0 ifscope [ethernet]", or "at (incomplete)" for an
// entry without a hardware address. Returns 0 on success, -1 when the table cannot be read
// (errno is set).
int write_arp_table(FILE *out);
