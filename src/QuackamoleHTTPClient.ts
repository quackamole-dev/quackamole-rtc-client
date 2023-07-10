import { IAdminRoom, IBaseRoom, IPlugin } from "quackamole-shared-types";

export class QuackamoleHttpClient {
  static async createRoom(): Promise<IAdminRoom | Error> {
    try {
      const res = await fetch(`http://localhost:12000/rooms`, { method: 'post', mode: 'cors' });
      return await res.json();
    } catch (e) {
      return new Error('failed to create room');
    }
  }

  static async getRoom(id: string): Promise<IBaseRoom> {
    try {
      const res = await fetch(`http://localhost:12000/rooms/${id}`, { method: 'get', mode: 'cors' });
      return await res.json();
    } catch (e) {
      throw new Error('failed to get room');
    }
  }

  static async getPlugins(): Promise<IPlugin[]> {
    try {
      const res = await fetch(`http://localhost:12000/plugins`, { method: 'get', mode: 'cors' });
      return await res.json();
    } catch (e) {
      throw new Error('failed to fetch plugins');
    }
  }
}
