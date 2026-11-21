// Only the public-web build replaces the Dexie Cloud addon. Any attempted
// cloud startup fails before the addon can register a transport.
export default function cloudDisabled(): never {
  throw Error('Cloud synchronization is unavailable in this build.');
}
