import {EventEmitter, IEvent} from 'quackamole-event-emitter';
import { HostToPluginMessage, IPBroadcastMessage, IPGetConnectedUsers, IPGetConnectedUsersResponse, IPGetCurrentRoom, IPGetCurrentRoomResponse, IPGetLocalUser, IPGetLocalUserResponse, IPMessageEnvelope, IPMessageUserMessage } from './sharedClientTypes';
import { AwaitId, IAwaitedPromise, IBaseRoom, IUser } from 'quackamole-shared-types';

export interface QuackamoleSdkAction {
  type: string;
  payload: IEvent
}

export class BaseQuackamoleSDK extends EventEmitter {
  private readonly awaitedPromises: Record<AwaitId, IAwaitedPromise> = {};

  windowTop: Window;
  constructor() {
    super();
    if (!window.top) throw new Error('window.top is undefined. This SDK must be used in an iframe.');
    this.windowTop = window.top;
    window.addEventListener('message', evt => this.handleMessageEvents(evt.data));
  }

  broadcast(eventType: string, body: unknown) {
    const action: IPBroadcastMessage = {type: 'p_request__room_broadcast', eventType, body, awaitId: '', timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
    this.emit(eventType, body);
  }

  message(receiverId: string, eventType: string, body: unknown) {
    const action: IPMessageUserMessage = {type: 'p_request__message_user', receiverId, eventType, body, awaitId: '', timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
  }

  async getLocalUser(): Promise<IUser> {
    const [awaitId, promise] = this.registerAwaitIdPromise<IPGetLocalUserResponse>();
    const action: IPGetLocalUser = {type: 'p_request__local_user', awaitId, timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
    const res =  await promise;
    if (!res.localUser) throw new Error('localUser is undefined - this should never happen as plugins can only be used after a user logged in');
    return res.localUser;
  }

  async getConnectedUsers(): Promise<IUser[]> {
    const [awaitId, promise] = this.registerAwaitIdPromise<IPGetConnectedUsersResponse>();
    const action: IPGetConnectedUsers = {type: 'p_request__connected_users', awaitId, timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
    const res =  await promise;
    return res.connectedUsers;
  }

  async getCurrentRoom(): Promise<IBaseRoom> {
    const [awaitId, promise] = this.registerAwaitIdPromise<IPGetCurrentRoomResponse>();
    const action: IPGetCurrentRoom = {type: 'p_request__current_room', awaitId, timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
    const res =  await promise;
    return res.currentRoom;
  }

  private handleMessageEvents(msg: HostToPluginMessage | IPMessageEnvelope) {
    if (msg.awaitId) return msg.type === 'p_response__error' ? this.awaitedPromises[msg.awaitId].reject(msg) : this.awaitedPromises[msg.awaitId].resolve(msg);
    else if (msg.type === 'PLUGIN_DATA') this.emit(msg.payload.eventType, msg.payload.data);
  }

  private registerAwaitIdPromise<T>(awaitId = crypto.randomUUID()): [AwaitId, Promise<T>] {
    let resolve: IAwaitedPromise['resolve'] = () => console.debug('resolve not set');
    let reject: IAwaitedPromise['resolve'] = () => console.debug('reject not set');
    const promise: Promise<T> = new Promise((res, rej) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      resolve = res;
      reject = rej;
    });
    this.awaitedPromises[awaitId] = { promise, resolve, reject };
    return [awaitId, promise];
  }
}
