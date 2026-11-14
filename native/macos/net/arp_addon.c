// Node-API module for the Mac App Store build: exposes arpTable(), which returns the IPv4
// neighbour table as `arp -an` text. It is loaded into the app's main process, the process that
// holds the entitlement macOS requires before it shows hardware addresses.

#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#include "arp_table.h"

static napi_value arp_table(napi_env env, napi_callback_info info) {
  (void)info;
  char *text = NULL;
  size_t len = 0;
  FILE *out = open_memstream(&text, &len);
  if (!out) {
    napi_throw_error(env, NULL, "arp: out of memory");
    return NULL;
  }
  int rc = write_arp_table(out);
  int saved = errno;
  fclose(out);
  if (rc != 0) {
    free(text);
    char message[128];
    snprintf(message, sizeof message, "arp: sysctl: %s", strerror(saved));
    napi_throw_error(env, NULL, message);
    return NULL;
  }
  napi_value result;
  napi_status status = napi_create_string_utf8(env, text ? text : "", len, &result);
  free(text);
  if (status != napi_ok) {
    napi_throw_error(env, NULL, "arp: could not create the result string");
    return NULL;
  }
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "arpTable", NAPI_AUTO_LENGTH, arp_table, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "arpTable", fn) != napi_ok) return NULL;
  return exports;
}
