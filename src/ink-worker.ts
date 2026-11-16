import { InkRuntime, type InkRequest } from "./ink-runtime";

const runtime = new InkRuntime();
self.onmessage = (event: MessageEvent<InkRequest>) => {
  self.postMessage(runtime.run(event.data));
};
