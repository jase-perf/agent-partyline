const form = document.getElementById('login-form')
const errorEl = document.getElementById('login-error')

form.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  errorEl.hidden = true
  const password = new FormData(form).get('password')
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  })
  if (res.ok) {
    const next = new URL(location.href).searchParams.get('next') || '/'
    location.href = next
  } else {
    errorEl.textContent = 'Incorrect password'
    errorEl.hidden = false
  }
})
