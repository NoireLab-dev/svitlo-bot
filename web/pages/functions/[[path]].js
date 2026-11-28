// Адреса без імені акаунта: svitlo-fortuna.pages.dev просто віддає сторінку й API з Worker svitlo
export const onRequest = ({ request }) => {
  const u = new URL(request.url)
  return fetch(`https://svitlo.thelightdeal.workers.dev${u.pathname}${u.search}`, { headers: { "user-agent": "svitlo-pages" } })
}
