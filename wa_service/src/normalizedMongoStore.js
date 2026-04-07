/**
 * NormalizedMongoStore
 *
 * Drop-in replacement for wwebjs-mongo MongoStore.
 * Strips the full path from the session key, using only path.basename().
 *
 * Why: RemoteAuth.save() passes the FULL PATH as options.session
 * (e.g. /app/.wwebjs_auth/RemoteAuth-<id>) but extract()/sessionExists()
 * pass only the session name (RemoteAuth-<id>). This mismatch means sessions
 * saved on one machine (local Windows) can never be found on another (Railway Linux).
 *
 * This store normalizes the key to always use just the basename, making it
 * path-independent and consistent across environments.
 */

const fs = require('fs');
const path = require('path');

class NormalizedMongoStore {
  constructor({ mongoose }) {
    if (!mongoose) throw new Error('A valid Mongoose instance is required for NormalizedMongoStore.');
    this.mongoose = mongoose;
  }

  _key(session) {
    return path.basename(session) || session;
  }

  async sessionExists(options) {
    const key = this._key(options.session);
    const col = this.mongoose.connection.db.collection(`whatsapp-${key}.files`);
    return !!(await col.countDocuments());
  }

  async save(options) {
    const key = this._key(options.session);
    const zipPath = options.session + '.zip';

    // Verifica ZIP valido prima di uploadare
    try {
      const stat = fs.statSync(zipPath);
      if (stat.size < 1024) throw new Error(`ZIP troppo piccolo (${stat.size}B)`);
    } catch (e) {
      throw new Error(`ZIP non valido: ${e.message}`);
    }

    const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
      bucketName: `whatsapp-${key}`,
    });
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(zipPath);
      rs.on('error', reject);
      rs.pipe(bucket.openUploadStream(`${key}.zip`))
        .on('error', reject)
        .on('close', resolve);
    });
    // Remove previous version
    const docs = await bucket.find({ filename: `${key}.zip` }).toArray();
    if (docs.length > 1) {
      const oldest = docs.reduce((a, b) => (a.uploadDate < b.uploadDate ? a : b));
      await bucket.delete(oldest._id);
    }
  }

  async extract(options) {
    const key = this._key(options.session);
    const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
      bucketName: `whatsapp-${key}`,
    });
    return new Promise((resolve, reject) => {
      bucket
        .openDownloadStreamByName(`${key}.zip`)
        .pipe(fs.createWriteStream(options.path))
        .on('error', reject)
        .on('close', resolve);
    });
  }

  async delete(options) {
    const key = this._key(options.session);
    const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
      bucketName: `whatsapp-${key}`,
    });
    const docs = await bucket.find({ filename: `${key}.zip` }).toArray();
    for (const doc of docs) await bucket.delete(doc._id);
  }
}

module.exports = NormalizedMongoStore;
