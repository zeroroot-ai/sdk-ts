import { createClient, type Client, type Transport } from "@connectrpc/connect"
import { ComponentService } from "./gen/gibson/component/v1/component_pb.js"
import { HarnessCallbackService } from "./gen/gibson/harness/v1/harness_callback_pb.js"

export { ComponentService, HarnessCallbackService }

export interface GibsonClients {
  component: Client<typeof ComponentService>
  harness: Client<typeof HarnessCallbackService>
}

export function createGibsonClients(transport: Transport): GibsonClients {
  return {
    component: createClient(ComponentService, transport),
    harness: createClient(HarnessCallbackService, transport),
  }
}
