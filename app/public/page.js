const button = document.querySelector('#check-storage');
const status = document.querySelector('#storage-result');
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Checking the app-to-private-storage path…';
  try {
    const response = await fetch('/health/storage', { cache: 'no-store', credentials: 'same-origin' });
    const result = await response.json();
    status.textContent = result.reason;
  } catch {
    status.textContent = 'The check could not complete. Ask the owner to inspect app/network readiness.';
  } finally {
    button.disabled = false;
  }
});
