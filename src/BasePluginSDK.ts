import {EventEmitter, IEvent} from 'quackamole-event-emitter';
import { IPBroadcastMessage, IPMessageUserMessage } from './sharedClientTypes';
import { randomUUID } from 'crypto';

export interface QuackamoleSdkAction {
  type: string;
  payload: IEvent
}

export class BaseQuackamoleSDK extends EventEmitter {
  windowTop: Window;
  constructor() {
    super();
    if (!window.top) throw new Error('window.top is undefined. This SDK must be used in an iframe.');
    this.windowTop = window.top;
    window.addEventListener('message', this.handleMessageEvents.bind(this));
  }

  broadcast(eventType: string, body: unknown) {
    const action: IPBroadcastMessage = {type: 'p_request__room_broadcast', eventType, body, awaitId: randomUUID(), timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
    this.emit(eventType, body);
  }

  message(receiverId: string, eventType: string, body: unknown) {
    const action: IPMessageUserMessage = {type: 'p_request__message_user', receiverId, eventType, body, awaitId: '', timestamp: Date.now(), pluginId: 'dummy'};
    this.windowTop.postMessage(action, '*');
  }

  relayMessage(peerIds: string[], eventType: string, data: unknown) {
    const action = {type: 'PLUGIN_SEND_TO_PEER_RELAY', payload: {peerIds, eventType, data}};
    this.windowTop.postMessage(action, '*');
  }

  private handleMessageEvents(evt: MessageEvent<IEvent>) {
    console.log('BaseQuackamoleSDK message received', evt);
    if (evt.data?.type === 'PLUGIN_DATA') this.emit(evt.type, evt.data);
  }
}
