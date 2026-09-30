export async function authorizeCookies(selected, api = globalThis.chrome) {
  const candidatesByOrigin = new Map();
  for (const candidate of selected) {
    const url = new URL(candidate.url);
    const origin = `${url.protocol}//${url.hostname}/*`;
    if (!candidatesByOrigin.has(origin)) candidatesByOrigin.set(origin, []);
    candidatesByOrigin.get(origin).push(candidate);
  }

  const requests = [...candidatesByOrigin].map(([origin, hostCandidates]) => ({
    origin,
    hostname: new URL(hostCandidates[0].url).hostname,
    result: api.permissions.request({ permissions: ['cookies'], origins: [origin] }),
  }));
  const granted = await Promise.all(requests.map(async (request) => ({
    ...request,
    granted: await request.result,
  })));
  const denied = granted.find((request) => !request.granted);
  if (denied) throw new Error(`未获得 ${denied.hostname} 的登录态权限，任务未启动。`);

  const permissionChecks = granted.map((request) => ({
    ...request,
    result: api.permissions.contains({ permissions: ['cookies'], origins: [request.origin] }),
  }));
  const validPermissions = await Promise.all(permissionChecks.map(async (request) => ({
    ...request,
    valid: await request.result,
  })));
  const invalid = validPermissions.find((request) => !request.valid);
  if (invalid) throw new Error(`${invalid.hostname} 的权限未生效，任务未启动。`);

  const cookiesByCandidate = [];
  for (const candidate of selected) {
    const cookies = await api.cookies.getAll({ url: candidate.url });
    cookiesByCandidate.push({ candidate, cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite,
    })) });
  }

  return cookiesByCandidate;
}
