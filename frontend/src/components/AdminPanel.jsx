import React, { useEffect, useState } from 'react'
import { fetchUsers, createUser, deleteUser, setUserSubdomain } from '../api'
import { fmtDate } from '../fmt'

function SubdomainCell({ user, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(user.subdomain || '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await setUserSubdomain(user.id, value.trim())
      onSaved()
      setEditing(false)
    } catch {}
    setSaving(false)
  }

  if (user.is_admin) return <span style={{ color: 'var(--text-3)', fontSize: '0.78rem' }}>server default</span>

  if (editing) return (
    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="name.olearyhouse.com"
        style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', padding: '0.2rem 0.4rem', fontSize: '0.78rem', width: 180 }}
        autoFocus
      />
      <button className="refresh-btn" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={handleSave} disabled={saving}>
        {saving ? '…' : 'Save'}
      </button>
      <button className="refresh-btn" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={() => { setValue(user.subdomain || ''); setEditing(false) }}>
        Cancel
      </button>
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      {user.subdomain
        ? <span style={{ color: 'var(--text-2)', fontSize: '0.78rem' }}>{user.subdomain}</span>
        : <span style={{ color: 'var(--red)', fontSize: '0.78rem' }}>not set</span>}
      <button className="refresh-btn" style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setEditing(true)}>
        Edit
      </button>
    </div>
  )
}

export default function AdminPanel({ currentUser }) {
  const [users, setUsers] = useState([])
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const load = () => fetchUsers().then(setUsers).catch(() => {})

  useEffect(() => { load() }, [])

  const handleCreate = async e => {
    e.preventDefault()
    setError('')
    setCreating(true)
    try {
      await createUser(newUsername.trim(), newPassword)
      setNewUsername('')
      setNewPassword('')
      load()
    } catch (r) {
      try { const d = await r.json(); setError(d.detail || 'Error') } catch { setError('Error creating user') }
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async id => {
    if (!confirm('Delete this user?')) return
    try { await deleteUser(id); load() } catch {}
  }

  return (
    <div>
      <div className="card">
        <h2>Members</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Subdomain</th>
                <th>Visible</th>
                <th>Joined</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>{u.username}{currentUser?.id === u.id && <span className="badge badge-1" style={{ marginLeft: '0.5rem' }}>you</span>}</td>
                  <td>{u.is_admin ? <span className="badge badge-top">Admin</span> : <span className="badge badge-gray">Member</span>}</td>
                  <td><SubdomainCell user={u} onSaved={load} /></td>
                  <td>{u.visible_in_garage ? <span className="badge badge-1">Yes</span> : <span className="badge badge-gray">No</span>}</td>
                  <td style={{ color: 'var(--text-3)' }}>{fmtDate(u.created_at)}</td>
                  <td>
                    {currentUser?.id !== u.id && (
                      <button
                        className="refresh-btn"
                        style={{ padding: '0.2rem 0.6rem', color: 'var(--red)', borderColor: 'var(--red)' }}
                        onClick={() => handleDelete(u.id)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Create User</h2>
        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div className="section-title" style={{ marginBottom: '0.35rem' }}>Username</div>
            <input
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              required
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', padding: '0.4rem 0.65rem', fontSize: '0.85rem' }}
            />
          </div>
          <div>
            <div className="section-title" style={{ marginBottom: '0.35rem' }}>Password</div>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', padding: '0.4rem 0.65rem', fontSize: '0.85rem' }}
            />
          </div>
          <button type="submit" className="refresh-btn" disabled={creating} style={{ padding: '0.4rem 1rem' }}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
        {error && <p style={{ color: 'var(--red)', fontSize: '0.75rem', marginTop: '0.5rem' }}>{error}</p>}
      </div>
    </div>
  )
}
