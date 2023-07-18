import { AwaitId, IBaseRoom, IUser, PluginId, RoomEventMessage, SocketId, UserId } from 'quackamole-shared-types';

/////////////////////////////
// PLUGIN TO HOST MESSAGES //
/////////////////////////////

// Messages that the plugin can send to its local host to request data or trigger allowed actions

export type PluginToHostMessage = IPBroadcastMessage | IPMessageUserMessage | IPGetLocalUser | IPGetConnectedUsers | IPGetCurrentRoom | IPSetMicrophoneEnabled | IPSetCameraEnabled | IPGetMetadata | IPSetMetadata | IHighlightUser | IPSubscribeToRoomEvent;

export interface IPBasePluginToHostMessage {
  awaitId: AwaitId;
  pluginId: PluginId;
  // body: ; // Imagine it like the body of an http request
  timestamp: number; // set immdiately by sendingPeer before sending
}

export interface IPBroadcastMessage<T = unknown> extends IPBasePluginToHostMessage {
  type: 'p_request__room_broadcast';
  eventType: string;
  body: T;
  data?: T; // legacy alias for body
}

export interface IPMessageUserMessage<T = unknown> extends IPBasePluginToHostMessage {
  type: 'p_request__message_user';
  receiverId: UserId,
  eventType: string;
  body: T;
}

export interface IPGetLocalUser extends IPBasePluginToHostMessage {
  type: 'p_request__local_user';
}

export interface IPGetConnectedUsers extends IPBasePluginToHostMessage {
  type: 'p_request__connected_users';
}

export interface IPGetCurrentRoom extends IPBasePluginToHostMessage {
  type: 'p_request__current_room';
}

export interface IPSetMicrophoneEnabled extends IPBasePluginToHostMessage {
  type: 'p_request__set_microphone_enabled';
  enabled: boolean;
}

export interface IPSetCameraEnabled extends IPBasePluginToHostMessage {
  type: 'p_request__set_camera_enabled';
  enabled: boolean;
}

export interface IPGetMetadata extends IPBasePluginToHostMessage {
  type: 'p_request__get_metadata';
  metadataKey: string;
  local?: boolean;
  server?: boolean;
}

export interface IPSetMetadata extends IPBasePluginToHostMessage {
  type: 'p_request__set_metadata';
  metadataKey: string;
  metadata: unknown;
  local?: boolean;
  server?: boolean;
}

export interface IHighlightUser extends IPBasePluginToHostMessage {
  type: 'p_request__highlight_user';
  userId: UserId;
}

export interface IPSubscribeToRoomEvent extends IPBasePluginToHostMessage {
  type: 'p_request__subscribe_to_room_event';
  eventType: RoomEventMessage['type'];
}

// This message type is special not sure in which category to put it
export interface IPMessageEnvelope<T = unknown> {
  // type: 'p_message_envelope';
  type: 'PLUGIN_DATA'; // used by legacy project
  awaitId: AwaitId;
  senderId: SocketId; // set by server to prevent malicious users from pretending to send messages as someone else
  payload: {
    eventType: string;
    data: T;
    body: unknown; // data === body for legacy reasons (data is an alias for the body)
  };
}

/////////////////////////////
// HOST TO PLUGIN MESSAGES //
/////////////////////////////

export type PluginToHostResponse = IPBroadcastResponse | IPMessagePeerResponse | IPGetLocalUserResponse | IPGetCurrentRoomResponse | IPGetConnectedUsersResponse | IPSetMicrophoneEnabledResponse | IPSetCameraEnabledResponse | IPSetMetadataResponse | IPGetMetadataResponse | IHighlightUserResponse | IPSubscribeToRoomEventResponse;
export type HostToPluginMessage = PluginToHostResponse | IPluginResponseErrorMessage;

// Messages sent by host back to the plugin in response to a request

export interface IPluginResponseMessage {
  type: string,
  awaitId: AwaitId;
  // body: unknown; // Imagine it like the body of an http request
  timestamp: number; // set immdiately by sendingPeer before sending
}

export interface IPBroadcastResponse extends IPluginResponseMessage {
  type: 'p_response__room_broadcast';
}

export interface IPMessagePeerResponse extends IPluginResponseMessage {
  type: 'p_response__message_users';
}

export interface IPGetLocalUserResponse extends IPluginResponseMessage {
  type: 'p_response__local_user';
  localUser: IUser | null;
}

export interface IPGetConnectedUsersResponse extends IPluginResponseMessage {
  type: 'p_response__connected_users';
  connectedUsers: IUser[];
}

export interface IPGetCurrentRoomResponse extends IPluginResponseMessage {
  type: 'p_response__current_room';
  currentRoom: IBaseRoom;
}

export interface IPSetMicrophoneEnabledResponse extends IPluginResponseMessage {
  type: 'p_response__set_microphone_enabled';
}

export interface IPSetCameraEnabledResponse extends IPluginResponseMessage {
  type: 'p_response__set_camera_enabled';
}

export interface IPSetMetadataResponse<T = unknown> extends IPluginResponseMessage {
  type: 'p_response__set_metadata';
  localMetadata?: T;
  serverMetadata?: T;
}

export interface IPGetMetadataResponse<T = unknown> extends IPluginResponseMessage {
  type: 'p_response__get_metadata';
  localMetadata?: T;
  serverMetadata?: T;
}

export interface IHighlightUserResponse extends IPluginResponseMessage {
  type: 'p_response__highlight_user';
}

export interface IPSubscribeToRoomEventResponse extends IPluginResponseMessage {
  type: 'p_response__subscribe_to_room_event';
}

export interface IPluginResponseErrorMessage {
  awaitId: AwaitId;
  type: 'p_response__error';
  requestType: PluginToHostMessage['type'];
  message: string;
  code: number;
}

// Messages sent by host to plugin that the plugin has to respond back to

export interface IBaseHostRequestMessage {
  type: string;
  awaitId: AwaitId;
  timestamp: number; // set immdiately by sendingPeer before sending
  body: unknown; // Imagine it like the body of an http request
}
