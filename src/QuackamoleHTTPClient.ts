import { IAdminRoom, IBaseRoom, IPlugin } from 'quackamole-shared-types';

// TODO make more generic by having .get() and .post() methods that take a resourcePath and a body.
//  Then either have a .getRoom() and .createRoom() that call those methods with the appropriate resourcePath and body.
//  Or just do something like: quackamole.http.get(quackamole.http.ROOMS, someId);
export class QuackamoleHttpClient {
  static baseUrl = 'http://localhost:12000';

  static async createRoom(): Promise<IAdminRoom | Error> {
    try {
      const res = await fetch(`${this.baseUrl}/rooms`, { method: 'post', mode: 'cors' });
      return await res.json();
    } catch (e) {
      return new Error('failed to create room');
    }
  }

  static async getRoom(id: string): Promise<IBaseRoom> {
    try {
      const res = await fetch(`${this.baseUrl}/rooms/${id}`, { method: 'get', mode: 'cors' });
      return await res.json();
    } catch (e) {
      throw new Error('failed to get room');
    }
  }

  static async getPlugins(): Promise<IPlugin[]> {
    try {
      const res = await fetch(`${this.baseUrl}/plugins`, { method: 'get', mode: 'cors' });
      return await res.json();
    } catch (e) {
      throw new Error('failed to fetch plugins');
    }
  }
}
