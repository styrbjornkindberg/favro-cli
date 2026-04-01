import FavroHttpClient from './http-client';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface Attachment {
  attachmentId: string;
  name: string;
  url: string;
  createdAt: string;
  cardCommonId?: string;
}

export class AttachmentsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * Upload an attachment to a card.
   */
  async uploadAttachment(cardCommonId: string, filePath: string): Promise<Attachment> {
    // We need to use Axios's internal form data handler since v1.0+ supports it directly
    // Or we circumvent standard config to inject the file
    
    // Fallback native node approach to form data boundary if pure Axios fails:
    // But axios handles object with Stream when content-type is multipart/form-data
    
    const fileName = path.basename(filePath);
    
    // We create a native FormData or just use Axios headers
    const axiosClient = this.client.getClient();
    
    // axios allows using FormData natively in Node >= 18
    const form = new FormData();
    const buffer = await fs.readFile(filePath);
    
    // We use Blob to represent the file data in native Fetch API style which Axios 1.6+ supports
    const blob = new Blob([buffer]);
    form.append('file', blob, fileName);

    const res = await axiosClient.post(`/cards/${cardCommonId}/attachments`, form, {
      headers: {
        'Content-Type': 'multipart/form-data',
      }
    });

    return res.data;
  }

  /**
   * Upload an attachment to a comment.
   */
  async uploadAttachmentToComment(commentId: string, filePath: string): Promise<Attachment> {
    const fileName = path.basename(filePath);
    const axiosClient = this.client.getClient();
    const form = new FormData();
    const buffer = await fs.readFile(filePath);
    const blob = new Blob([buffer]);
    form.append('file', blob, fileName);

    const res = await axiosClient.post(`/comments/${commentId}/attachments`, form, {
      headers: {
        'Content-Type': 'multipart/form-data',
      }
    });

    return res.data;
  }
}

export default AttachmentsAPI;
