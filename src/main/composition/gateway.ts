// Composition root: the shared gateway async-request store, one per process.
import { GatewayAsyncRequestStore } from '@offgrid/models'
import { once } from '@offgrid/models'

export const gatewayAsyncRequests = once(() => new GatewayAsyncRequestStore())
