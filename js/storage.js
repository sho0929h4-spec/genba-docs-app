// js/storage.js — ファイル保存アダプタ。Supabase直呼びはこのファイルだけに閉じる
const AppStorage = {
  bucket: 'files',
  async upload(path, blob, opts = {}) {
    const o = { upsert: opts.upsert !== false }; // 既定は上書き
    if (opts.contentType) o.contentType = opts.contentType;
    const { error } = await sb.storage.from(this.bucket).upload(path, blob, o);
    if (error) throw error;
    return path;
  },
  async getUrl(path, expiresIn = 3600) {
    const { data, error } = await sb.storage.from(this.bucket).createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  },
  // 既存ファイルのサイズ(byte)。取れなければ0
  async sizeOf(path) {
    try {
      const i = path.lastIndexOf('/');
      const { data, error } = await sb.storage.from(this.bucket).list(path.slice(0, i), { search: path.slice(i + 1) });
      if (error || !data) return 0;
      const f = data.find(x => x.name === path.slice(i + 1));
      return (f && f.metadata && f.metadata.size) || 0;
    } catch (e) { return 0; }
  },
  async remove(path) {
    const { error } = await sb.storage.from(this.bucket).remove([path]);
    if (error) throw error;
  }
};
