import { WEBUI_API_BASE_URL } from '$lib/constants';

// C1 backend contract (open_webui/routers/policies.py):
//   GET    /api/v1/policies              -> { policies: PolicyListItem[], total }
//   POST   /api/v1/policies              -> 201 Policy (create, body {id,name,markdown_content})
//   GET    /api/v1/policies/{id}         -> Policy | 404 {error}
//   PUT    /api/v1/policies/{id}         -> Policy (draft only, body {markdown_content})
//   DELETE /api/v1/policies/{id}         -> 204 (draft only)
//   POST   /api/v1/policies/{id}/compile -> {compiled_rego, warnings} | 400/503 {error, details?}
//   POST   /api/v1/policies/{id}/deploy  -> {status, deployed_at, message} | 400 {status,error,rolled_back,message} | 502 {error,details}
//   POST   /api/v1/policies/{id}/rollback -> {status, message} | 400/502 {error, details?}
//
// Timestamps are epoch-ns integers (NOT ISO strings) — see formatEpochNs in $lib/utils/policies.

export type PolicyStatus = 'draft' | 'active';

export type Policy = {
	id: string;
	name: string;
	markdown_content: string;
	compiled_rego: string | null;
	status: PolicyStatus;
	active_rego: string | null;
	previous_rego: string | null;
	created_by: string;
	created_at: number; // epoch ns
	deployed_at: number | null; // epoch ns
	last_error: string | null;
	updated_at: number; // epoch ns
};

export type PolicyListItem = {
	id: string;
	name: string;
	status: PolicyStatus;
	created_by: string;
	created_at: number; // epoch ns
	deployed_at: number | null; // epoch ns
};

export type PolicyListResponse = {
	policies: PolicyListItem[];
	total: number;
};

export type CompileResponse = {
	compiled_rego: string;
	warnings: string[];
};

export type DeployResponse = {
	status: string;
	deployed_at?: number;
	message?: string;
	error?: string;
	rolled_back?: boolean;
};

/**
 * Error thrown for any failed API call. status 0 = network-level failure
 * (connection lost), everything else is an HTTP status code.
 */
export class ApiError extends Error {
	status: number;
	/** Parsed response body, when one was available (e.g. deploy 400's {message, rolled_back}). */
	body: unknown;

	constructor(status: number, message: string, body: unknown = null) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}

/**
 * Backend error shape is {error, details?}; keep this in one place since
 * several endpoints have slightly different failure bodies (compile 400,
 * deploy 400 with rolled_back, generic {error}).
 */
export const extractApiError = (body: unknown, fallback = 'Unknown error'): string => {
	if (body && typeof body === 'object') {
		const obj = body as Record<string, unknown>;
		if (typeof obj.error === 'string') return obj.error;
		if (typeof obj.detail === 'string') return obj.detail;
		if (typeof obj.message === 'string') return obj.message;
	}
	return fallback;
};

const request = async <T>(token: string, path: string, method: string, body?: unknown): Promise<T> => {
	let res: Response;
	try {
		res = await fetch(`${WEBUI_API_BASE_URL}${path}`, {
			method,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				authorization: `Bearer ${token}`
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch (e) {
		throw new ApiError(0, 'Connection lost. Please check your connection and retry.');
	}

	if (res.status === 204) {
		return undefined as T;
	}

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
		throw new ApiError(res.status, extractApiError(json, `Request failed with status ${res.status}`), json);
	}

	return json as T;
};

export const fetchPolicies = (token: string) => request<PolicyListResponse>(token, '/policies', 'GET');

export const fetchPolicy = (token: string, id: string) =>
	request<Policy>(token, `/policies/${encodeURIComponent(id)}`, 'GET');

export const createPolicy = (token: string, id: string, name: string, markdown: string) =>
	request<Policy>(token, '/policies', 'POST', { id, name, markdown_content: markdown });

export const updatePolicy = (token: string, id: string, markdown: string) =>
	request<Policy>(token, `/policies/${encodeURIComponent(id)}`, 'PUT', { markdown_content: markdown });

export const compilePolicy = (token: string, id: string) =>
	request<CompileResponse>(token, `/policies/${encodeURIComponent(id)}/compile`, 'POST');

export const deployPolicy = (token: string, id: string) =>
	request<DeployResponse>(token, `/policies/${encodeURIComponent(id)}/deploy`, 'POST');

export const rollbackPolicy = (token: string, id: string) =>
	request<DeployResponse>(token, `/policies/${encodeURIComponent(id)}/rollback`, 'POST');

export const deletePolicy = (token: string, id: string) =>
	request<void>(token, `/policies/${encodeURIComponent(id)}`, 'DELETE');
