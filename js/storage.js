// js/storage.js — ファイル保存アダプタ。Supabase直呼びはこのファイルだけに閉じる
const AppStorage = {
  bucket: 'files',
  // 送付メールのPDF用の公開バケット（migration 012）。URLを知っている人は誰でも開ける。パスは {org}/{乱数uuid}/report.pdf
  PUBLIC_PDF_BUCKET: 'public-pdfs',
  // opts.bucket で保存先のバケットを選べる（既定は files）
  async upload(path, blob, opts = {}) {
    const o = { upsert: opts.upsert !== false }; // 既定は上書き
    if (opts.contentType) o.contentType = opts.contentType;
    const { error } = await sb.storage.from(opts.bucket || this.bucket).upload(path, blob, o);
    if (error) throw error;
    return path;
  },
  async getUrl(path, expiresIn = 3600) {
    const { data, error } = await sb.storage.from(this.bucket).createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  },
  // 期限のない公開URL（バケットが public のときだけ開ける）
  getPublicUrl(path, bucket) {
    return sb.storage.from(bucket || this.bucket).getPublicUrl(path).data.publicUrl;
  },
  // 既存ファイルのサイズ(byte)。取れなければ0
  async sizeOf(path, bucket) {
    try {
      const i = path.lastIndexOf('/');
      const { data, error } = await sb.storage.from(bucket || this.bucket).list(path.slice(0, i), { search: path.slice(i + 1) });
      if (error || !data) return 0;
      const f = data.find(x => x.name === path.slice(i + 1));
      return (f && f.metadata && f.metadata.size) || 0;
    } catch (e) { return 0; }
  },
  async remove(path, bucket) {
    const { error } = await sb.storage.from(bucket || this.bucket).remove([path]);
    if (error) throw error;
  }
};
