import * as Q from 'quackamole-shared-types';

export class QuackamoleRTCClient {
  private socket: WebSocket;
  private socketId: string | null = null;
  private currentRoom: Q.IBaseRoom | null = null;
  private currentPlugin: Q.IPlugin | null = null;

  private localUser: Q.IUser | null = null;
  private localStream: MediaStream | undefined;
  private localStreamMicEnabled = false;
  private localStreamCamEnabled = false;
  private readonly localStreamConstraints: MediaStreamConstraints = defaultMediaConstraints;

  private iframe: HTMLIFrameElement | null = null;
  private readonly awaitedPromises: Record<Q.AwaitId, Q.IAwaitedPromise> = {};
  private readonly connections: Map<Q.IUser['id'], Q.PeerConnection> = new Map();
  private readonly streams: Map<Q.IUser['id'], MediaStream> = new Map();
  private readonly users: Map<Q.IUser['id'], Q.IUser> = new Map();
  private readonly iframeContainerLocator: any;

  constructor(url: string, iframeContainerLocator: string) {
    console.log('QuackamoleRTCClient constructor', url);
    this.socket = new WebSocket(url);
    this.socket.onmessage = evt => this.handleSocketMessages(evt.data);
    this.socket.onopen = evt => this.onsocketstatus('open', evt);
    this.socket.onclose = evt => this.onsocketstatus('closed', evt);
    this.socket.onerror = evt => this.onsocketstatus('error', evt);
    this.iframeContainerLocator = iframeContainerLocator;
    window.addEventListener('message', evt => evt.data.type && evt.data.type.startsWith('PLUGIN') && this.handlePluginMessageLegacy(evt.data));
  }

  onconnection = (id: string, connection: Q.PeerConnection | null) => { };
  onremoteuserdata = (id: string, userData: Q.IUser | null) => { };
  onlocaluserdata = (userData: Q.IUser) => { };
  onsocketstatus = (status: 'open' | 'closed' | 'error', evt?: Event) => { };
  onsetplugin = (plugin: Q.IPlugin | null, iframeId: string) => { };

  async toggleMicrophoneEnabled(): Promise<void> {
    this.localStreamMicEnabled = !this.localStreamMicEnabled;
    if (this.localStream || this.localStreamMicEnabled) await this.startLocalStream();
  }

  async toggleCameraEnabled(): Promise<void> {
    this.localStreamCamEnabled = !this.localStreamCamEnabled;
    if (this.localStream || this.localStreamCamEnabled) await this.startLocalStream();
  }

  async setPlugin(plugin: Q.IPlugin): Promise<void> {
    // TODO pass iframe element directly to this method.
    //  if there is an edit mode for a room, a select dropdown above the plugin content area could be shown.
    //  Since there could be multiple plugin content areas on the grid, this would make things easier to identify.
    if (!this.currentRoom) return;
    if (this.iframe?.src && this.iframe.src === plugin.url) return;
    if (!this.iframe) {
      this.iframe = document.createElement('iframe');
      this.iframe.style.cssText = `width: 100%; height: 100%; border: none`;
      document.querySelector(this.iframeContainerLocator)?.appendChild(this.iframe);
      if (!document.body.contains(this.iframe)) throw new Error(`iframe could not be attached to locator: "${this.iframeContainerLocator}"`);
    }

    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IPluginSetResponseMessage>();
    const message: Q.IPluginSetMessage = { action: 'plugin_set', awaitId, data: { plugin, iframeId: this.iframe.id, roomId: this.currentRoom.id } };
    this.socket.send(JSON.stringify(message));
    const res = await promise;
    console.log('--------set plugin res', res);
    this.currentPlugin = plugin;
    this.iframe.src = plugin.url;
    this.onsetplugin(res.plugin, res.iframeId);
  }

  async registerUser(displayName: string): Promise<Q.IUser | Error> {
    console.log('trying to register user');
    if (!this.socket) return new Error('socket undefined');
    if (this.socket.readyState !== WebSocket.OPEN) return new Error('socket not open');

    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IUserRegisterResponseMessage>();
    const message: Q.IUserRegisterMessage = { action: 'user_register', awaitId, data: { displayName } };
    this.socket.send(JSON.stringify(message));
    const response = await promise;

    if (response.errors?.length) return new Error(response.errors?.join(', '));
    if (response.secret.length === 0) return new Error('secret is empty');

    localStorage.setItem('secret', response.secret);
    this.onlocaluserdata({ ...response.user });
    return response.user;
  }

  async loginUser(): Promise<Q.IUser | Error> {
    const secret = localStorage.getItem('secret'); // TODO allow adapters to change behaviour or move login and register completely to a AnonymousLoginAdapter
    console.log('trying to login user with secret', secret);
    if (this.localUser) return new Error('already logged in');
    if (!secret) return new Error('secret not found. Please register first');
    if (!this.socket) return new Error('socket undefined');
    if (this.socket.readyState !== WebSocket.OPEN) return new Error('socket not open');
    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IUserLoginResponseMessage>();
    const message: Q.IUserLoginMessage = { action: 'user_login', awaitId, data: { secret } };
    this.socket.send(JSON.stringify(message));
    const response = await promise;
    if (response.errors?.length) return new Error(response.errors?.join(', '));
    console.log('loginUser success with socketId', response)
    this.socketId = response.user.id;
    this.localUser = response.user;
    this.localUser.stream = this.localStream;
    this.onlocaluserdata({ ...response.user });
    return response.user;
  }

  async joinRoom(roomId: string): Promise<Q.IBaseRoom | Error> {
    if (!this.socket) return new Error('socket undefined');
    if (this.socket && !this.socketId) return new Error('socket id undefined');
    if (this.socket.readyState !== WebSocket.OPEN) return new Error('socket not open');
    const [awaitId, promise] = this.registerAwaitIdPromise<Q.IRoomJoinResponseMessage>();
    const message: Q.IRoomJoinMessage = { action: 'room_join', awaitId, data: { roomId } };
    this.socket.send(JSON.stringify(message));
    const response = await promise;
    if (response.errors?.length) return new Error(response.errors?.join(', '));
    this.currentRoom = response.room;
    response.users.forEach(u => {
      if (u.id === this.localUser?.id) return;
      this.users.set(u.id, u);
      this.onremoteuserdata(u.id, u);
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
    // if (!this.localStreamMicEnabled && !this.localStreamCamEnabled) 
    const audioTracks = this.localStream?.getAudioTracks();
    const videoTracks = this.localStream?.getVideoTracks();
    if (audioTracks?.length && !this.localStreamMicEnabled) audioTracks.forEach(t => t.stop());
    if (videoTracks?.length && !this.localStreamCamEnabled) videoTracks.forEach(t => t.stop());
    // await this.stopLocalStream(); // TODO instead of completely stopping the stream, just remove the tracks that are not needed anymore
    if (!this.localUser) return new Error('local user not set');
    const actualConstraints = { ...this.localStreamConstraints };
    actualConstraints.audio = this.localStreamMicEnabled ? actualConstraints.audio : false;
    actualConstraints.video = this.localStreamCamEnabled ? actualConstraints.video : false;

    try {
      console.log('startLocalStream', this.localStreamMicEnabled, this.localStreamCamEnabled, actualConstraints);
      this.localStream = await navigator.mediaDevices.getUserMedia(actualConstraints);
      this.localUser.stream = this.localStream;
      this.onlocaluserdata({ ...this.localUser });
      await this.updateStreamForConnections(this.localStream);
      return this.localStream;
    } catch (error) {
      this.localUser.stream = undefined;
      this.onlocaluserdata({ ...this.localUser });
      return new Error('local stream couldn\'t be started');
    }
  };

  private async stopLocalStream() {
    if (!this.localStream) return;
    console.log('stopLocalStream');
    this.clearStreamTracks(this.localStream);
    this.localStream = undefined;
    this.updateStreamForConnections(this.localStream);
  };

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
    const m = JSON.parse(messageRaw);
    console.log('handleSocketMessages', m);

    // messages with an awaitId are handled wherever they are awaited.
    if (m.awaitId) return m.errors?.length ? this.awaitedPromises[m.awaitId].reject(m.errors) : this.awaitedPromises[m.awaitId].resolve(m);

    if (m.type === 'message_relay_delivery') {
      if (m.data?.iceCandidates) return this.handleRTCIceCandidates(m);
      else if (m.data?.description) return this.handleSessionDescription(m);
    }

    if (m.type === 'room_event') {
      if (m.eventType === 'user_joined') return this.handleUserJoined(m.data);
      else if (m.eventType === 'user_left') return this.handleUserLeft(m.data);
      else if (m.eventType === 'plugin_set') return this.handleSetPlugin(m.data);
      // else if (m.eventType === 'layout_changed') return this.handleLayoutChange(m.data.user);
    }
  }

  private async handleUserJoined({ user }: Q.IRoomEventJoinMessage['data']) {
    user.stream = this.streams.get(user.id);
    this.onremoteuserdata(user.id, user);
    this.users.set(user.id, user);
  }

  private async handleUserLeft({ user }: Q.IRoomEventLeaveMessage['data']) {
    this.removeConnection(user.id);
  }

  handleSetPlugin({ roomId, iframeId, plugin }: Q.IRoomEventPluginSet['data']) {
    console.log(`remote user set plugin ${plugin?.url} for ${iframeId}`, this.iframe);
    if (!this.iframe) {
      this.iframe = document.createElement('iframe');
      this.iframe.style.cssText = `width: 100%; height: 100%; border: none`;
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

    if (message.data.description.type === 'offer') {
      console.log(`You received an OFFER from "${message.senderId}"...`);
      if (!connection) connection = await this.createConnection(message.senderId, false);
      await connection.setRemoteDescription(new RTCSessionDescription(message.data.description));
      await this.sendSessionDescriptionToConnection(connection, false);
      // When remote user disabled both cam and mic, we need to remove the stream here otherwise it remains stuck on last frame here.
      const user = this.users.get(message.senderId);
      if (user && !message.data.streamEnabled) {
        user.stream = undefined;
        this.onremoteuserdata(message.senderId, { ...user });
      }
    } else if (message.data.description.type === 'answer') {
      if (!connection) return console.error('No offer was ever made for the received answer. Investigate!');
      console.log(`You received an ANSWER from "${message.senderId}"...`);
      await connection.setRemoteDescription(new RTCSessionDescription(message.data.description));
    }
  }

  private async handleRTCIceCandidates(message: Q.IMessageRelayDeliveryMessage<Q.IRTCIceCandidatesMessage>) {
    const connection = this.connections.get(message.senderId);
    console.log(`You received ICE CANDIDATES from "${message.senderId}"...`, connection, message);
    if (!connection) return console.error('handleRTCIceCandidates - connection not found');
    for (const candidate of message.data.iceCandidates) await connection.addIceCandidate(candidate);
  }

  private handleDataChannelMessages(messageRaw: string) {
    const message = JSON.parse(messageRaw);
    console.log('handleDataChannelMessages', message);

    if (message.type === 'PLUGIN_DATA') {
      if (!this.iframe) throw new Error('iframe not set');
      this.iframe.contentWindow?.postMessage(message, '*');
      window.postMessage(message, '*'); // TODO remove this why needed?
    }
  }

  private handlePluginMessageLegacy(message: Q.IPluginMessageLegacy) {
    if (message.type === 'PLUGIN_SEND_TO_ALL_PEERS') this.sendPluginMessageToAllConnections(message);
    else if (message.type === 'PLUGIN_SEND_TO_PEER') this.sendPluginMessageToConnection(message);
  }

  private sendPluginMessageToAllConnections(message: Q.IPluginMessageLegacy) {
    const data = { type: 'PLUGIN_DATA', payload: message.payload };
    console.log('-------------LEGACY PLUGIN MESSAGE---', data, this.connections);
    this.connections.forEach(c => this.sendDataToConnection(c.defaultDataChannel, data));
  };

  private sendPluginMessageToConnection(message: Q.IPluginMessageLegacy) {
    const connection = this.connections.get(message.socketId);
    if (!connection) return console.error('sendPluginMessageToConnection - connection not found');
    const data = { type: 'PLUGIN_DATA', payload: message.payload };
    this.sendDataToConnection(connection.defaultDataChannel, data);
  }

  sendDataToConnection(dataChannel: RTCDataChannel, data: { type: string; payload: any; }) {
    console.log('---------send to connection', dataChannel, data);
    if (!dataChannel) return;
    const serializedData = JSON.stringify(data);
    dataChannel.send(serializedData);
  }


  private sendSessionDescriptionToConnection = async (connection: Q.PeerConnection, isOffer = true) => {
    if (!this.socketId) throw new Error('socketId not set');
    if (!this.currentRoom) throw new Error('currentRoom not set');
    const description = isOffer ? await connection.createOffer() : await connection.createAnswer();
    await connection.setLocalDescription(description);
    console.log('Sending description to remote peer...', description);
    const data: Q.IRTCSessionDescriptionMessage = { type: 'session_description', description, senderSocketId: this.socketId, micEnabled: this.localStreamMicEnabled, camEnabled: this.localStreamCamEnabled, streamEnabled: Boolean(this.localStream) };
    const message: Q.IMessageRelayMessage = { action: 'message_relay', receiverIds: [connection.remoteSocketId], roomId: this.currentRoom?.id, data };
    this.socket.send(JSON.stringify(message));
  };

  private async createConnection(remoteSocketId: string, createDataChannel = true): Promise<Q.PeerConnection> {
    if (!this.socketId) throw new Error('socketId not defined');
    if (this.socketId === remoteSocketId) throw new Error('cannot connect with yourself');
    if (this.connections.has(remoteSocketId)) return this.connections.get(remoteSocketId) as Q.PeerConnection;
    console.log(`Creating new RTCPeerConnection with "${remoteSocketId}" ...`);

    const newConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], iceCandidatePoolSize: 1 }) as Q.PeerConnection;
    newConnection.remoteSocketId = remoteSocketId;
    if (createDataChannel) {
      newConnection.defaultDataChannel = newConnection.createDataChannel('default');
      this.setupDataChannelListeners(newConnection.defaultDataChannel);
    }
    this.setupConnectionListeners(newConnection);

    this.connections.set(remoteSocketId, newConnection);
    this.onconnection(newConnection.remoteSocketId, newConnection);

    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      console.log(`Adding ${tracks.length}x stream tracks to the new RTCPeerConnection with "${remoteSocketId}"...`);
      for (const track of tracks) newConnection.addTrack(track, this.localStream);
    };


    // this.sendSessionDescriptionToConnection(newConnection, isOffer);
    return newConnection;
  }

  private removeConnection(connectionSocketId: Q.SocketId) {
    const connection = this.connections.get(connectionSocketId);
    if (!connection) return console.error('removeConnection - connection not found');

    // if (connection && connection.remoteSocketId && connection.socketId) return; // TODO why was this returned here ???????
    if (connection.stream) this.clearStreamTracks(connection.stream);
    connection.close();
    this.connections.delete(connection.remoteSocketId);
    this.streams.delete(connection.remoteSocketId);
    this.users.delete(connection.remoteSocketId);
    this.onconnection(connection.remoteSocketId, null);
    this.onremoteuserdata(connection.remoteSocketId, null);
  }

  private setupConnectionListeners(connection: Q.PeerConnection) {
    if (!this.socket) return;
    if (!this.socketId) return;
    if (!this.currentRoom) return;

    console.log(`Initializing RTCPeerConnection listeners...`);
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
        const data: Q.IRTCIceCandidatesMessage = { type: 'ice_candidates', iceCandidates, senderSocketId };
        const message: Q.IMessageRelayMessage = { action: 'message_relay', roomId, data, receiverIds: [connection.remoteSocketId] };
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

    connection.ontrack = ({ track, streams }) => {
      if (!streams || !streams[0]) return console.error('ontrack - this should not happen... streams[0] is empty!');
      this.streams.set(connection.remoteSocketId, streams[0])

      const user = this.users.get(connection.remoteSocketId);
      if (!user) return; // no use in continuing when user not loaded yet

      user.stream = streams[0];
      this.onremoteuserdata(connection.remoteSocketId, { ...user });
    };

    connection.onnegotiationneeded = () => console.log(`(negotiationneeded for connection "${connection.remoteSocketId}"...)`);
    connection.oniceconnectionstatechange = () => connection.iceConnectionState === 'failed' && connection.restartIce();
    connection.onsignalingstatechange = evt => connection.signalingState === 'stable' && connection.localDescription && connection.remoteDescription && console.log('CONNECTION ESTABLISHED!! signaling state:', connection.signalingState);
    connection.ondatachannel = async evt => {
      console.log('Remote peer opened a data channel with you...', evt);
      connection.defaultDataChannel = evt.channel;
      this.setupDataChannelListeners(connection.defaultDataChannel);
    };
  }

  private setupDataChannelListeners(dataChannel: RTCDataChannel) {
    if (!dataChannel) return;
    console.log(`Initializing data channel listeners...`);
    dataChannel.onopen = () => console.log('datachannel open...');
    dataChannel.onclose = () => console.log('datachannel close');
    dataChannel.onerror = evt => console.log('datachannel error:', evt);
    dataChannel.onmessage = evt => this.handleDataChannelMessages(evt.data);
  };

  private clearStreamTracks = (stream?: MediaStream) => {
    if (!stream) return;
    if (!stream.getTracks) return console.error('something wrong with the stream:', stream);
    stream.getTracks().forEach(track => track.stop());
  }

  private registerAwaitIdPromise<T>(awaitId = crypto.randomUUID()): [Q.AwaitId, Promise<T>] {
    let resolve: Q.IAwaitedPromise['resolve'] = () => { };
    let reject: Q.IAwaitedPromise['resolve'] = () => { };
    const promise: Promise<T> = new Promise((res, rej) => {
      // @ts-ignore
      resolve = res;
      reject = rej;
    });
    this.awaitedPromises[awaitId] = { promise, resolve, reject };
    return [awaitId, promise];
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
