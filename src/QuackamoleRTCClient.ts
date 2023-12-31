import * as Q from 'quackamole-shared-types';
import { QuackamoleHttpClient } from '.';
import { IPBroadcastMessage, IPGetCurrentRoom, IPGetCurrentRoomResponse, IPGetLocalUser, IPGetLocalUserResponse, IPGetMetadata, IPGetConnectedUsers, IPGetConnectedUsersResponse, IPMessageEnvelope, IPMessageUserMessage, IPSetCameraEnabled, IPSetMetadata, IPSetMicrophoneEnabled, PluginToHostMessage, IPSetMicrophoneEnabledResponse, IPSetCameraEnabledResponse, IPSetMetadataResponse, IPluginResponseErrorMessage } from './sharedClientTypes';

export class QuackamoleRTCClient {
  readonly http = QuackamoleHttpClient;
  readonly localUserInfo: IUserInfo = { user: undefined, stream: undefined, micEnabled: true, camEnabled: true };
  readonly remoteUserInfoMap: Record<Q.IUser['id'], IUserInfo> = {};
  readonly localStreamConstraints: MediaStreamConstraints = defaultMediaConstraints;
  private socket: WebSocket;
  private socketId: string | null = null;
  private currentRoom: Q.IBaseRoom | null = null;
  private currentPlugin: Q.IPlugin | null = null;
  private iframe: HTMLIFrameElement | null = null;

  private readonly awaitedPromises: Record<Q.AwaitId, Q.IAwaitedPromise> = {};
  private readonly connections: Map<Q.IUser['id'], Q.PeerConnection> = new Map();
  private readonly iframeContainerLocator: string;

  constructor(apiUrl: string, websocketUrl: string, secure: boolean, iframeContainerLocator: string) {
    this.http.baseUrl = `${secure ? 'https' : 'http'}://${apiUrl}`;
    console.log('QuackamoleRTCClient api Url:', apiUrl, 'websocket url:', websocketUrl, 'secure:', secure);
    this.socket = new WebSocket(`${secure ? 'wss' : 'ws'}://${websocketUrl}`);
    this.socket.onmessage = evt => this.handleSocketMessages(evt.data);
    this.socket.onopen = evt => this.onsocketstatus('open', evt);
    this.socket.onclose = evt => this.onsocketstatus('closed', evt);
    this.socket.onerror = evt => this.onsocketstatus('error', evt);
    this.iframeContainerLocator = iframeContainerLocator;
    window.addEventListener('message', evt => evt.data.type && this.handleEmbeddedPluginMessage(evt.data));
    setTimeout(() => this.onlocaluserdata({ ...this.localUserInfo }), 0);
  }

  // onconnection = (id: string, connection: Q.PeerConnection | null) => console.debug('onconnection', id, connection);
  onremoteuserdata = (id: Q.UserId, value: IUserInfo | undefined) => console.debug('onremoteuserdata', id, value);
  onlocaluserdata = (value: IUserInfo) => console.debug('onlocaluserdata', value);
  onsocketstatus = (status: 'open' | 'closed' | 'error', evt?: Event) => console.debug('onsocketstatus', status, evt);
  onsetplugin = (plugin: Q.IPlugin | null, iframeId: string) => console.debug('onsetplugin', plugin, iframeId);

  async toggleMicrophoneEnabled(): Promise<void> {
    this.localUserInfo.micEnabled = !this.localUserInfo.micEnabled;
    if (this.localUserInfo.stream || this.localUserInfo.micEnabled) await this.startLocalStream();
  }

  async toggleCameraEnabled(): Promise<void> {
    this.localUserInfo.camEnabled = !this.localUserInfo.camEnabled;
    if (this.localUserInfo.stream || this.localUserInfo.camEnabled) await this.startLocalStream();
  }

  async setPlugin(plugin: Q.IPlugin): Promise<void> {
    // TODO pass iframe element directly to this method.
    //  if there is an edit mode for a room, a select dropdown above the plugin content area could be shown.
    //  Since there could be multiple plugin content areas on the grid, this would make things easier to identify.
    if (!this.currentRoom) return;
    if (this.iframe?.src && this.iframe.src === plugin.url) return;
    if (!this.iframe) {
      this.iframe = document.createElement('iframe');
      this.iframe.style.cssText = 'width: 100%; height: 100%; border: none';
      document.querySelector(this.iframeContainerLocator)?.appendChild(this.iframe);
      if (!document.body.contains(this.iframe)) throw new Error(`iframe could not be attached to locator: "${this.iframeContainerLocator}"`);
    }

    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IPluginSetResponseMessage>();
    const message: Q.IPluginSetMessage = { type: 'request__plugin_set', awaitId, body: { plugin, iframeId: this.iframe.id, roomId: this.currentRoom.id } };
    this.socket.send(JSON.stringify(message));
    const res = await promise;
    this.currentPlugin = plugin;
    this.iframe.src = plugin.url;
    this.onsetplugin(res.plugin, res.iframeId);
  }

  async registerUser(displayName: string): Promise<Q.IUser | Error> {
    console.log('trying to register user');
    if (!this.socket) return new Error('socket undefined');
    if (this.socket.readyState !== WebSocket.OPEN) return new Error('socket not open');

    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IUserRegisterResponseMessage>();
    const message: Q.IUserRegisterMessage = { type: 'request__user_register', awaitId, body: { displayName } };
    this.socket.send(JSON.stringify(message));
    const response = await promise;

    if (response.secret.length === 0) return new Error('secret is empty');

    localStorage.setItem('secret', response.secret);
    // this.onlocaluserdata({ ...response.user });
    return response.user;
  }

  async loginUser(): Promise<Q.IUser | Error> {
    const secret = localStorage.getItem('secret'); // TODO allow adapters to change behaviour or move login and register completely to a AnonymousLoginAdapter
    console.log('trying to login user with secret', secret);
    if (this.localUserInfo.user) return new Error('already logged in');
    if (!secret) return new Error('secret not found. Please register first');
    if (!this.socket) return new Error('socket undefined');
    if (this.socket.readyState !== WebSocket.OPEN) return new Error('socket not open');
    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IUserLoginResponseMessage>();
    const message: Q.IUserLoginMessage = { type: 'request__user_login', awaitId, body: { secret } };
    this.socket.send(JSON.stringify(message));
    const response = await promise;
    // if (response.errors?.length) return new Error(response.errors?.join(', '));
    console.log('loginUser success with socketId', response);
    this.socketId = response.user.id;
    this.localUserInfo.user = response.user;
    this.onlocaluserdata({ ...this.localUserInfo });
    return response.user;
  }

  async joinRoom(roomId: string): Promise<Q.IBaseRoom | Error> {
    if (!this.socket) return new Error('socket undefined');
    if (this.socket && !this.socketId) return new Error('socket id undefined');
    if (this.socket.readyState !== WebSocket.OPEN) return new Error('socket not open');
    if (this.currentRoom?.id === roomId) return new Error('already in room');
    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IRoomJoinResponseMessage>();
    const message: Q.IRoomJoinMessage = { type: 'request__room_join', awaitId, body: { roomId } };
    this.socket.send(JSON.stringify(message));
    const response = await promise;
    // if (response.errors?.length) return new Error(response.errors?.join(', '));
    this.currentRoom = response.room;
    response.users.forEach(user => {
      if (user.id === this.localUserInfo.user?.id) return;
      const info = this.remoteUserInfoMap[user.id] || {} as IUserInfo;
      info.user = user;
      this.onremoteuserdata(user.id, {...info});
    });
    await this.startLocalStream();

    // TODO this better be done with Promise.all()
    const idsToConnect = response.room.joinedUsers.filter(userId => userId !== this.socketId);
    for (const userId of idsToConnect) {
      const connection = await this.createConnection(userId);
      await this.sendSessionDescriptionToConnection(connection);
    }

    return response.room;
  }

  async startLocalStream(): Promise<MediaStream | Error> {
    await this.stopLocalStream();
    const actualConstraints = { ...this.localStreamConstraints };
    actualConstraints.audio = this.localUserInfo.micEnabled ? actualConstraints.audio : false;
    actualConstraints.video = this.localUserInfo.camEnabled ? actualConstraints.video : false;

    try {
      console.log('startLocalStream - user info', this.localUserInfo, actualConstraints);
      this.localUserInfo.stream = await navigator.mediaDevices.getUserMedia(actualConstraints);
      this.onlocaluserdata({ ...this.localUserInfo });
      await this.updateStreamForConnections(this.localUserInfo.stream);
      return this.localUserInfo.stream;
    } catch (error) {
      this.localUserInfo.stream = undefined;
      this.onlocaluserdata({ ...this.localUserInfo });
      await this.updateStreamForConnections(undefined);
      return new Error('local stream couldn\'t be started');
    }
  }

  async stopLocalStream() {
    if (!this.localUserInfo.stream) return;
    console.log('stopLocalStream');
    this.clearStreamTracks(this.localUserInfo.stream);
    this.localUserInfo.stream = undefined;
    // notifyConnections && this.updateStreamForConnections(undefined);
  }

  private async updateStreamForConnections(newStream?: MediaStream): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const connection of this.connections.values()) {
      console.log(`Updating localStream for RTCPeerConnection with "${connection.remoteSocketId}"...`);
      await Promise.all(connection.getSenders().map(s => connection.removeTrack(s)));
      if (newStream) await Promise.all(newStream.getTracks().map(t => connection.addTrack(t, newStream)));
      promises.push(this.sendSessionDescriptionToConnection(connection, true));
    }
    await Promise.all(promises);
  }

  private handleSocketMessages(messageRaw: string) {
    const m: Q.ServerToSocketMessage = JSON.parse(messageRaw);
    console.log('handleSocketMessages', m);
    // messages with an awaitId are handled wherever they are awaited.
    if (m.awaitId) return m.type === 'response__error' ? this.awaitedPromises[m.awaitId].reject(m) : this.awaitedPromises[m.awaitId].resolve(m);
    if (m.type === 'message_relay_delivery') {
      // TODO fix this mess
      if ((m as Q.IMessageRelayDeliveryMessage<Q.IRTCIceCandidatesMessage>).relayData?.type === 'ice_candidates') return this.handleRTCIceCandidates(m as Q.IMessageRelayDeliveryMessage<Q.IRTCIceCandidatesMessage>);
      if ((m as Q.IMessageRelayDeliveryMessage<Q.IRTCSessionDescriptionMessage>).relayData?.type === 'session_description') return this.handleSessionDescription(m as Q.IMessageRelayDeliveryMessage<Q.IRTCSessionDescriptionMessage>);
    }
    if (m.type === 'room_event__user_joined') return this.handleUserJoined(m);
    else if (m.type === 'room_event__user_left') return this.handleUserLeft(m);
    else if (m.type === 'room_event__plugin_set') return this.handleSetPlugin(m);
    // else if (m.type === 'room_event__layout_changed') return this.handleLayoutChange(m.data.user);
  }

  private async handleUserJoined(msg: Q.IRoomEventJoinMessage) {
    const { user } = msg.data;
    const info = this.remoteUserInfoMap[user.id] || {} as IUserInfo;
    info.user = user;
    this.onremoteuserdata(user.id, { ...info });
    this.sendMessageToEmbeddedPlugin(msg);
    this.remoteUserInfoMap[user.id] = info;
  }

  private async handleUserLeft(msg: Q.IRoomEventLeaveMessage) {
    this.sendMessageToEmbeddedPlugin(msg);
    this.removeConnection(msg.data.user.id);
  }

  handleSetPlugin(msg: Q.IRoomEventPluginSet) {
    const { iframeId, plugin } = msg.data;
    console.log(`remote user set plugin ${plugin?.url} for ${iframeId}`, this.iframe);
    if (!this.iframe) {
      this.iframe = document.createElement('iframe');
      this.iframe.style.cssText = 'width: 100%; height: 100%; border: none';
      document.querySelector(this.iframeContainerLocator)?.appendChild(this.iframe);
      if (!document.body.contains(this.iframe)) throw new Error(`iframe could not be attached to locator: "${this.iframeContainerLocator}"`);
    }

    const newSrc = plugin?.url || '';
    if (this.iframe.src && this.iframe.src === newSrc) return;
    this.iframe.src = newSrc;
  }

  private async handleSessionDescription(message: Q.IMessageRelayDeliveryMessage<Q.IRTCSessionDescriptionMessage>) {
    let connection = this.connections.get(message.senderId);
    if (!this.socketId) return console.error('handleSessionDescription - socketId not set');
    if (!this.currentRoom) return console.error('handleSessionDescription - currentRoom not set');

    if (message.relayData.description.type === 'offer') {
      console.log(`You received an OFFER from "${message.senderId}"...`);
      if (!connection) connection = await this.createConnection(message.senderId);
      await connection.setRemoteDescription(new RTCSessionDescription(message.relayData.description));
      await this.sendSessionDescriptionToConnection(connection, false);
      // When remote user disabled both cam and mic, we need to remove the stream here otherwise it remains stuck on last frame here.
      const info = this.remoteUserInfoMap[message.senderId] || {} as IUserInfo;
      info.micEnabled = message.relayData.micEnabled;
      info.camEnabled = message.relayData.camEnabled;
      info.stream = message.relayData.streamEnabled ? info.stream : undefined;
      this.onremoteuserdata(message.senderId, { ...info});
    } else if (message.relayData.description.type === 'answer') {
      if (!connection) return console.error('No offer was ever made for the received answer. Investigate!');
      console.log(`You received an ANSWER from "${message.senderId}"...`);
      await connection.setRemoteDescription(new RTCSessionDescription(message.relayData.description));
    } else {
      throw new Error(`handleSessionDescription - unknown description type: ${message.relayData.description.type}`);
    }
  }

  private async handleRTCIceCandidates(message: Q.IMessageRelayDeliveryMessage<Q.IRTCIceCandidatesMessage>) {
    const connection = this.connections.get(message.senderId);
    console.log(`You received ICE CANDIDATES from "${message.senderId}"...`, connection, message);
    if (!connection) return console.error('handleRTCIceCandidates - connection not found');
    for (const candidate of message.relayData.iceCandidates) await connection.addIceCandidate(candidate);
  }

  private handleDataChannelMessages(messageRaw: string) {
    const message: IPMessageEnvelope = JSON.parse(messageRaw);
    console.log('handleDataChannelMessages', message);
    if (message.type === 'PLUGIN_DATA') this.sendMessageToEmbeddedPlugin(message);
  }

  private sendSessionDescriptionToConnection = async (connection: Q.PeerConnection, isOffer = true) => {
    if (!this.socketId) throw new Error('socketId not set');
    if (!this.currentRoom) throw new Error('currentRoom not set');
    const description = isOffer ? await connection.createOffer() : await connection.createAnswer();
    await connection.setLocalDescription(description);
    console.log('Sending description to remote peer...', description);
    const relayData: Q.IRTCSessionDescriptionMessage  = { type: 'session_description', description, senderSocketId: this.socketId, micEnabled: Boolean(this.localUserInfo.micEnabled), camEnabled: Boolean(this.localUserInfo.camEnabled), streamEnabled: Boolean(this.localUserInfo.stream) };
    const message: Q.IMessageRelayMessage<Q.IRTCSessionDescriptionMessage> = { type: 'request__message_relay', awaitId: '', body: { receiverIds: [connection.remoteSocketId], roomId: this.currentRoom?.id, relayData } };
    this.socket.send(JSON.stringify(message));
  };

  private sendMessageToEmbeddedPlugin<T = unknown>(message: T) {
    // if (!this.iframe) throw new Error('iframe not set');
    if (!this.iframe) return console.error('ATTENTION: iframe reference not set');
    console.log('Sending message to embedded plugin...', this.iframe.contentWindow, message);
    this.iframe.contentWindow?.postMessage(message, '*');
    // window.postMessage(message, '*');
  }

  private async createConnection(remoteSocketId: string): Promise<Q.PeerConnection> {
    if (!this.socketId) throw new Error('socketId not defined');
    if (this.socketId === remoteSocketId) throw new Error('cannot connect with yourself');
    if (this.connections.has(remoteSocketId)) return this.connections.get(remoteSocketId) as Q.PeerConnection;
    console.log(`Creating new RTCPeerConnection with "${remoteSocketId}" ...`);

    const newConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], iceCandidatePoolSize: 1 }) as Q.PeerConnection;
    newConnection.remoteSocketId = remoteSocketId;
    newConnection.defaultDataChannel = newConnection.createDataChannel('default');
    this.setupDataChannelListeners(newConnection.defaultDataChannel);
    this.setupConnectionListeners(newConnection);

    this.connections.set(remoteSocketId, newConnection);
    // this.onconnection(newConnection.remoteSocketId, newConnection);

    if (this.localUserInfo.stream) {
      const tracks = this.localUserInfo.stream.getTracks();
      console.log(`Adding ${tracks.length}x stream tracks to the new RTCPeerConnection with "${remoteSocketId}"...`);
      for (const track of tracks) newConnection.addTrack(track, this.localUserInfo.stream);
    }

    return newConnection;
  }

  private removeConnection(connectionSocketId: Q.SocketId) {
    const connection = this.connections.get(connectionSocketId);
    if (!connection) return console.error('removeConnection - connection not found');

    // if (connection && connection.remoteSocketId && connection.socketId) return; // TODO why was this returned here ???????
    if (connection.stream) this.clearStreamTracks(connection.stream);
    connection.close();
    this.connections.delete(connection.remoteSocketId);
    delete this.remoteUserInfoMap[connection.remoteSocketId];
    this.onremoteuserdata(connection.remoteSocketId, undefined);
  }

  private setupConnectionListeners(connection: Q.PeerConnection) {
    if (!this.socket) return;
    if (!this.socketId) return;
    if (!this.currentRoom) return;

    console.log('Initializing RTCPeerConnection listeners...');
    const DELAY_MULTIPLIER = 1.5;
    const BASE_DELAY = 450;
    const MAX_ITERATIONS = 9;
    let currentIteration = 0;
    let iceCandidates: RTCIceCandidate[] = [];
    const senderSocketId = this.socketId;
    const roomId = this.currentRoom.id;

    // The goal is to send ice-candidates out quickly with the least amount of signaling until the null event which can take a long time
    const timer = () => { // TODO pass currentIteration as param
      if (iceCandidates.length) {
        console.log(`Sending ${iceCandidates.length}x ICE CANDIDATES to peer...`);
        const relayData: Q.IRTCIceCandidatesMessage = { type: 'ice_candidates', iceCandidates, senderSocketId };
        const message: Q.IMessageRelayMessage<Q.IRTCIceCandidatesMessage> = { type: 'request__message_relay', awaitId: '', body: {receiverIds: [connection.remoteSocketId], roomId, relayData} };
        this.socket.send(JSON.stringify(message));
        iceCandidates = [];
      }

      currentIteration <= MAX_ITERATIONS && setTimeout(timer, BASE_DELAY * Math.pow(DELAY_MULTIPLIER, currentIteration++));
    };
    timer();

    connection.onicecandidate = evt => {
      if (evt.candidate) {
        iceCandidates.push(evt.candidate);
      } else {
        console.log('no more ICE');
        currentIteration = MAX_ITERATIONS + 1;
        timer();
      }
    };

    connection.ontrack = ({ streams }) => {
      if (!streams || !streams[0]) return console.error('ontrack - this should not happen... streams[0] is empty!');
      const info = this.remoteUserInfoMap[connection.remoteSocketId] || {} as IUserInfo;
      info.stream = streams[0];
      console.log(`Received remote stream from "${connection.remoteSocketId}"... user info ${info}`);
      this.onremoteuserdata(connection.remoteSocketId, { ...info });
    };

    connection.onnegotiationneeded = () => console.log(`(negotiationneeded for connection "${connection.remoteSocketId}"...)`);
    connection.oniceconnectionstatechange = () => connection.iceConnectionState === 'failed' && connection.restartIce();
    connection.onsignalingstatechange = () => connection.signalingState === 'stable' && connection.localDescription && connection.remoteDescription && console.log('CONNECTION ESTABLISHED!! signaling state:', connection.signalingState);
    connection.ondatachannel = async evt => {
      console.log('Remote peer opened a data channel with you...', evt);
      connection.defaultDataChannel = evt.channel;
      this.setupDataChannelListeners(connection.defaultDataChannel);
    };
  }

  private setupDataChannelListeners(dataChannel: RTCDataChannel) {
    if (!dataChannel) return;
    console.log('Initializing data channel listeners...');
    dataChannel.onopen = () => console.log('datachannel open...');
    dataChannel.onclose = () => console.log('datachannel close');
    dataChannel.onerror = evt => console.log('datachannel error:', evt);
    dataChannel.onmessage = evt => this.handleDataChannelMessages(evt.data);
  }

  private clearStreamTracks = (stream?: MediaStream) => {
    if (!stream) return;
    if (!stream.getTracks) return console.error('something wrong with the stream:', stream);
    stream.getTracks().forEach(track => track.stop());
  };

  private registerAwaitIdPromise<T>(): [Q.AwaitId, Promise<T>] {
    const awaitId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let resolve: Q.IAwaitedPromise['resolve'] = () => console.debug('resolve not set');
    let reject: Q.IAwaitedPromise['resolve'] = () => console.debug('reject not set');
    const promise: Promise<T> = new Promise((res, rej) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      resolve = res;
      reject = rej;
    });
    this.awaitedPromises[awaitId] = { promise, resolve, reject };
    return [awaitId, promise];
  }

  ///////////////////////////////////////////////
  // PLUGIN RELATED METHODS TO BE EXTRACTED TO SEPARATE CLASS?

  private async handleEmbeddedPluginMessage(message: PluginToHostMessage) {
    console.log('handleEmbeddedPluginMessage message:', message);
    // eslint-disable-next-line
    // @ts-ignore - this is for legacy reasons until old plugins get updated
    if (message.type === 'PLUGIN_SEND_TO_ALL_PEERS') await this.handlePluginBroadcastMessage({ type: 'p_request__room_broadcast', body: message.payload.data, data: message.payload.data, awaitId: '', timestamp: Date.now(), pluginId: '', eventType: message.payload.eventType });
    if (message.type === 'p_request__room_broadcast') await this.handlePluginBroadcastMessage(message);
    else if (message.type === 'p_request__message_user') await this.handlePluginMessageUserMessage(message);
    else if (message.type === 'p_request__local_user') await this.handlePluginRequestLocalUserMessage(message);
    else if (message.type === 'p_request__current_room') await this.handlePluginRequestCurrentRoomMessage(message);
    else if (message.type === 'p_request__connected_users') await this.handlePluginRequestConnectedUsersMessage(message);
    else if (message.type === 'p_request__set_microphone_enabled') await this.handlePluginSetMicrophoneEnabledMessage(message);
    else if (message.type === 'p_request__set_camera_enabled') await this.handlePluginSetCameraEnabledMessage(message);
    else if (message.type === 'p_request__get_metadata') await this.handlePluginGetMetadataMessage(message);
    else if (message.type === 'p_request__set_metadata') await this.handlePluginSetMetadataMessage(message);
    else this.sendMessageToEmbeddedPlugin<IPluginResponseErrorMessage>({ type: 'p_response__error', awaitId: message.awaitId, requestType: message.type, message: 'unknown request type', code: 400 });
  }
  async handlePluginSetMetadataMessage(message: IPSetMetadata) {
    // TODO does nothing right now
    this.sendMessageToEmbeddedPlugin<IPSetMetadataResponse>({ type: 'p_response__set_metadata', awaitId: message.awaitId, timestamp: Date.now() });
  }
  async handlePluginGetMetadataMessage(message: IPGetMetadata) {
    // TODO does nothing right now
    this.sendMessageToEmbeddedPlugin<IPSetCameraEnabledResponse>({ type: 'p_response__set_camera_enabled', awaitId: message.awaitId, timestamp: Date.now() });
  }

  async handlePluginSetCameraEnabledMessage(message: IPSetCameraEnabled) {
    // await this.toggleCameraEnabled(message.enabled);
    this.sendMessageToEmbeddedPlugin<IPSetCameraEnabledResponse>({ type: 'p_response__set_camera_enabled', awaitId: message.awaitId, timestamp: Date.now() });
  }

  async handlePluginSetMicrophoneEnabledMessage(message: IPSetMicrophoneEnabled) {
    // await this.toggleMicrophoneEnabled(message.enabled);
    this.sendMessageToEmbeddedPlugin<IPSetMicrophoneEnabledResponse>({ type: 'p_response__set_microphone_enabled', awaitId: message.awaitId, timestamp: Date.now() });
  }

  async handlePluginRequestConnectedUsersMessage(message: IPGetConnectedUsers) {
    const connectedUserIds = Array.from(this.connections.keys());
    // TODO this may be an issue when we don't have userdata for all connections
    const connectedUsers = connectedUserIds.map(id => this.remoteUserInfoMap[id]).filter(Boolean) as Q.IUser[];
    this.sendMessageToEmbeddedPlugin<IPGetConnectedUsersResponse>({ type: 'p_response__connected_users', awaitId: message.awaitId, connectedUsers, timestamp: Date.now() });
  }

  async handlePluginRequestCurrentRoomMessage(message: IPGetCurrentRoom) {
    this.sendMessageToEmbeddedPlugin<IPGetCurrentRoomResponse>({ type: 'p_response__current_room', awaitId: message.awaitId, currentRoom: this.currentRoom!, timestamp: Date.now() });
  }

  async handlePluginRequestLocalUserMessage(message: IPGetLocalUser) {
    this.sendMessageToEmbeddedPlugin<IPGetLocalUserResponse>({ type: 'p_response__local_user', awaitId: message.awaitId, localUser: this.localUserInfo.user, timestamp: Date.now() });
  }

  private async handlePluginBroadcastMessage(message: IPBroadcastMessage) {
    const {awaitId, eventType, body} = message;
    if (!this.localUserInfo.user?.id) return console.error('handlePluginBroadcastMessage - localUser not set');
    const enveloped: IPMessageEnvelope  = { type: 'PLUGIN_DATA', awaitId, senderId: this.localUserInfo.user.id,  payload: { eventType, data: body, body } };
    // For now we just send the message to all connections. This is different than the broadcast relay message which is sent to the server and then relayed to all users of the room.
    // The plugin itself has to verify wheather all necessary users received the message if that is required.
    this.connections.forEach(c => this.sendDataToConnection(c.defaultDataChannel, enveloped));
  }

  private async handlePluginMessageUserMessage(message: IPMessageUserMessage) {
    const {awaitId, receiverId, eventType, body} = message;
    const connection = this.connections.get(receiverId);
    if (!connection) return console.error('handlePluginMessageUserMessage - connection not found');
    if (!this.localUserInfo.user?.id) return console.error('handlePluginMessageUserMessage - localUser not set');
    this.sendDataToConnection(connection.defaultDataChannel, { type: 'PLUGIN_DATA', awaitId, senderId: this.localUserInfo.user.id, payload: {eventType, body, data: body} });
  }

  sendDataToConnection(dataChannel: RTCDataChannel, data: IPMessageEnvelope) {
    console.log('sendDataToConnection', dataChannel, data);
    if (!dataChannel) return;
    const serializedData = JSON.stringify(data);
    dataChannel.send(serializedData);
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const defaultMediaConstraints: MediaStreamConstraints = {
  audio: {},
  video: {
    // frameRate: { ideal: 20, max: 25 }, // FIXME check supported constraints first to prevent errors
    width: { ideal: 128 },
    height: { ideal: 72 }
  }
};

// TODO hide away complexity and the fact that we are sending a websocket message for awaited messages, create a lower level base class handling that and inherit from it

export interface IUserInfo {
  user?: Q.IUser;
  stream?: MediaStream;
  micEnabled?: boolean;
  camEnabled?: boolean;
}
