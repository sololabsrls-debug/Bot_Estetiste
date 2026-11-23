jest.mock('mongoose', () => ({ connection: { db: null } }));
const mongoose = require('mongoose');
const { contactSessionRegex, clearContactSessionKeys, clearLoggedOutSession } = require('../src/mongoUtils');

describe('contactSessionRegex', () => {
  const ids = [
    '393401234567.0', '393401234567.12',          // target PN devices
    '123456789012345_1.0', '123456789012345.3',   // target LID (Baileys 7 + legacy Baileys 6)
    '3934012345670.0',                             // longer number containing the target
    '99393401234567.0',                            // number ending with the target
    '123456789012345_1.0x', '393401234567',        // malformed
    '393409999999.0', '555556789012345_1.0',       // other contacts
  ];
  const match = (re) => ids.filter(id => new RegExp(re).test(id));

  it('matches only the exact contact PN and LID sessions (anchored)', () => {
    expect(match(contactSessionRegex('393401234567', '123456789012345')))
      .toEqual(['393401234567.0', '393401234567.12', '123456789012345_1.0', '123456789012345.3']);
  });

  it('works with PN only and strips a leading +', () => {
    expect(match(contactSessionRegex('+393401234567', null))).toEqual(['393401234567.0', '393401234567.12']);
  });

  it('returns null for empty or non numeric input (never matches everything)', () => {
    expect(contactSessionRegex('', null)).toBeNull();
    expect(contactSessionRegex('abc', '.*')).toBeNull();
  });
});

describe('clearContactSessionKeys', () => {
  it('deletes exactly the matched ids for the tenant', async () => {
    const coll = {
      find: jest.fn(() => ({ toArray: async () => [{ id: '393401234567.0' }, { id: '123456789012345_1.0' }] })),
      deleteMany: jest.fn(async () => ({ deletedCount: 2 })),
    };
    mongoose.connection.db = { collection: jest.fn(() => coll) };
    const r = await clearContactSessionKeys('t1', '393401234567', '123456789012345');
    expect(r).toEqual({ deleted: 2, ids: ['393401234567.0', '123456789012345_1.0'] });
    expect(coll.find.mock.calls[0][0]).toEqual({ tenantId: 't1', type: 'session', id: { $regex: contactSessionRegex('393401234567', '123456789012345') } });
    expect(coll.deleteMany).toHaveBeenCalledWith({ tenantId: 't1', type: 'session', id: { $in: ['393401234567.0', '123456789012345_1.0'] } });
  });

  it('does not touch the database when there is nothing to match', async () => {
    const coll = { find: jest.fn(), deleteMany: jest.fn() };
    mongoose.connection.db = { collection: jest.fn(() => coll) };
    await expect(clearContactSessionKeys('t1', null, null)).resolves.toEqual({ deleted: 0, ids: [] });
    expect(coll.find).not.toHaveBeenCalled();
  });
});

describe('clearLoggedOutSession', () => {
  const makeDb = (credsDoc) => {
    const creds = { findOne: jest.fn(async () => credsDoc), deleteOne: jest.fn(async () => ({ deletedCount: 1 })) };
    const keys = { deleteMany: jest.fn(async () => ({ deletedCount: 7 })) };
    mongoose.connection.db = { collection: jest.fn(n => (n === 'wa_creds' ? creds : keys)) };
    return { creds, keys };
  };

  it('deletes keys and creds when the stored creds are the ones that were logged out', async () => {
    const { creds, keys } = makeDb({ _id: 't1' });
    await expect(clearLoggedOutSession('t1', 1234)).resolves.toEqual({ cleared: true, keysDeleted: 7 });
    expect(creds.findOne.mock.calls[0][0]).toEqual({ _id: 't1', 'creds.registrationId': 1234 });
    expect(keys.deleteMany).toHaveBeenCalledWith({ tenantId: 't1' });
    expect(creds.deleteOne).toHaveBeenCalledWith({ _id: 't1', 'creds.registrationId': 1234 });
  });

  it('never deletes anything when the stored creds belong to a newer pairing', async () => {
    const { creds, keys } = makeDb(null);
    await expect(clearLoggedOutSession('t1', 1234)).resolves.toEqual({ cleared: false, keysDeleted: 0, reason: 'creds_changed_or_missing' });
    expect(keys.deleteMany).not.toHaveBeenCalled();
    expect(creds.deleteOne).not.toHaveBeenCalled();
  });

  it('does nothing without a registrationId', async () => {
    const { creds } = makeDb({ _id: 't1' });
    await expect(clearLoggedOutSession('t1', undefined)).resolves.toEqual({ cleared: false, keysDeleted: 0, reason: 'no_registration_id' });
    expect(creds.findOne).not.toHaveBeenCalled();
  });
});
