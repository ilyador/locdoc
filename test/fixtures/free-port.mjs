import { createServer } from "node:net";
import { once } from "node:events";

// A loopback port nothing listens on, for a fixture server to bind. A fixed
// port can belong to another local server, and then every test of its file
// fails. Derive each URL, origin and Host header a test sends from it.
export async function freePort() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}
