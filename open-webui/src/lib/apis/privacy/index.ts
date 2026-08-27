import { WEBUI_API_BASE_URL } from '$lib/constants';

// Backend contract (open_webui/routers/privacy.py — admin only, proxies MADE):
//   GET    /api/v1/privacy/mappings?limit&offset   -> EntityMapping[]
//   PATCH  /api/v1/privacy/mappings/{id}            -> EntityMapping  (body {original_value?, placeholder?})
//   DELETE /api/v1/privacy/mappings/{id}            -> 204
//   GET    /api/v1/privacy/leaks?limit&offset       -> RedactionLeak[]
// Timestamps are ISO strings (MADE emits datetime.isoformat()).

export type EntityMapping = {
	id: string;
	entity_type: string;
	placeholder: string;
	original_value: string;
	created_at: string;
};

export type RedactionLeak = {
	id: string;
	entity_types: string[];
	span_count: number;
	context_hash: string;
	created_at: string;
};

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

const request = async <T>(token: string, path: string, method: string, body?: unknown): Promise<T> => {
	let res: Response;
	try {
		res = await fetch(`${WEBUI_API_BASE_URL}/privacy${path}`, {
			method,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				authorization: `Bearer ${token}`
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch {
		throw new ApiError(0, 'Connection lost. Please check your connection and retry.');
	}

	if (res.status === 204) return undefined as T;

	const text = await res.text().catch(() => '');
	let json: unknown = null;
	if (text) {
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
	}

	if (!res.ok) {
		const detail =
			json && typeof json === 'object' && 'detail' in json
				? String((json as Record<string, unknown>).detail)
				: `Request failed with status ${res.status}`;
		throw new ApiError(res.status, detail);
	}
	return json as T;
};

export const fetchMappings = (token: string, limit = 500) =>
	request<EntityMapping[]>(token, `/mappings?limit=${limit}`, 'GET');

export const updateMapping = (
	token: string,
	id: string,
	patch: { original_value?: string; placeholder?: string }
) => request<EntityMapping>(token, `/mappings/${encodeURIComponent(id)}`, 'PATCH', patch);

export const deleteMapping = (token: string, id: string) =>
	request<void>(token, `/mappings/${encodeURIComponent(id)}`, 'DELETE');

export const fetchLeaks = (token: string, limit = 200) =>
	request<RedactionLeak[]>(token, `/leaks?limit=${limit}`, 'GET');
