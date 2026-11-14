# Contributing to Meshwork

Thank you for helping. Meshwork is a tool for on-site network work, so the most valuable
contributions come from real equipment.

## Reporting a device or switch Meshwork gets wrong

Open an issue and include:

- what Meshwork showed and what the device actually is (make, model, firmware);
- the output of **Copy details** from the device's drawer (remove anything private first:
  names, serial numbers, public addresses);
- for map problems, the switch model and firmware, and which ports are involved.

## Pull requests

1. Open an issue first for anything larger than a small fix, so the approach can be agreed.
2. Keep changes focused; do not reformat code you are not changing.
3. Add or update tests. Test data must be invented: private ranges (`10.0.0.0/8`,
   `192.168.0.0/16`) for local networks, documentation ranges (`192.0.2.0/24`,
   `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`) for public addresses, and made-up MAC
   addresses. Never use captures from a real network.
4. Run `pnpm typecheck` and `pnpm test` before opening the pull request.
5. User-facing changes need a line in `src/shared/release-notes.ts` for the next version.

Code comments describe what the code does and why: inputs, outputs, edge cases and non-obvious
decisions.

## Contributor Licence Agreement

Before a pull request can be merged, its author agrees to the project's Contributor Licence
Agreement; you will be asked to do so on your first pull request. The agreement lets Influx Network LLC distribute
your contribution under the GPL and through app stores whose terms are not compatible with the
GPL. You keep the copyright of your work.

## Licence

By contributing, you agree that your contribution is licensed under the GNU General Public
License v3.0, the licence of this project.
