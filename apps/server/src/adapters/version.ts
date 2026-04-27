// FLOOM protocol version shared by server and adapter modules.
//
// This tracks compatibility for the adapter contract in spec/adapters.md.
// Bump policy:
// - Pre-1.0: minor bumps MAY be breaking and adapter authors are expected
//   to declare a narrow compatible range (for example: ^0.2).
// - Post-1.0: standard semver compatibility applies.
export const FLOOM_PROTOCOL_VERSION = '0.2.0' as const;
