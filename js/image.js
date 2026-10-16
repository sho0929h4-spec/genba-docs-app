// js/image.js — 写真は端末側で圧縮してからアップする
const ImageUtil = {
  MAX_EDGE: 1600,
  QUALITY: 0.8,
  MAX_ORIGINAL: 20 * 1024 * 1024,
  MAX_PDF: 10 * 1024 * 1024,
  async prepareFile(file) {
    if (file.size > this.MAX_ORIGINAL) throw new Error(`「${file.name}」は20MBを超えています`);
    if (file.type === 'application/pdf') {
      if (file.size > this.MAX_PDF) throw new Error(`PDF「${file.name}」は10MBまでです`);
      return { blob: file, name: file.name, type: file.type, size: file.size };
    }
    if (!file.type.startsWith('image/')) throw new Error(`「${file.name}」は添付できません（写真かPDFのみ）`);
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, this.MAX_EDGE / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx2d = canvas.getContext('2d');
      ctx2d.fillStyle = '#fff'; // PNG透過が黒くならないよう白で塗る
      ctx2d.fillRect(0, 0, w, h);
      ctx2d.drawImage(bmp, 0, 0, w, h);
      bmp.close && bmp.close();
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', this.QUALITY));
      if (!blob) throw new Error('圧縮に失敗');
      const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      return { blob, name, type: 'image/jpeg', size: blob.size };
    } catch (e) {
      throw new Error(`写真「${file.name}」を読み込めませんでした`);
    }
  }
};
