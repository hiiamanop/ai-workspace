import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ApiError,
	compilePolicy,
	createPolicy,
	deletePolicy,
	deployPolicy,
	extractApiError,
	fetchPolicies,
	fetchPolicy,
	rollbackPolicy,
	updatePolicy
} from './index';

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const mockFetch = vi.fn();

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
	mockFetch.mockImplementation(impl);
	vi.stubGlobal('fetch', mockFetch);
};

afterEach(() => {
	vi.unstubAllGlobals();
	mockFetch.mockReset();
});

describe('policy API client', () => {
	const policy = {
		id: 'budget',
		name: 'Budget Policy',
		markdown_content: '# Budget',
		compiled_rego: 'package budget',
		status: 'draft',
		active_rego: null,
		previous_rego: null,
		created_by: 'user-1',
		created_at: 1755093600000000000,
		deployed_at: null,
		last_error: null,
		updated_at: 1755093600000000000
	};

	it('fetchPolicies: GET /api/v1/policies with bearer token, parses {policies, total}', async () => {
		stubFetch(async (url, init) => {
			expect(url).toBe('/api/v1/policies');
			expect(init.method).toBe('GET');
			expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
			return jsonResponse({ policies: [policy], total: 1 });
		});

		const res = await fetchPolicies('tok-1');
		expect(res.total).toBe(1);
		expect(res.policies[0].id).toBe('budget');
		// epoch-ns timestamps stay numbers, not ISO strings
		expect(res.policies[0].created_at).toBe(1755093600000000000);
	});

	it('fetchPolicy: GET with encoded id, returns full policy', async () => {
		stubFetch(async (url) => {
			expect(url).toBe('/api/v1/policies/my.policy_1');
			return jsonResponse(policy);
		});
		const res = await fetchPolicy('tok-1', 'my.policy_1');
		expect(res.status).toBe('draft');
		expect(res.compiled_rego).toBe('package budget');
	});

	it('createPolicy: POST with {id, name, markdown_content}', async () => {
		stubFetch(async (url, init) => {
			expect(url).toBe('/api/v1/policies');
			expect(init.method).toBe('POST');
			expect(JSON.parse(init.body as string)).toEqual({
				id: 'new-id',
				name: 'Untitled Policy',
				markdown_content: '# Hello'
			});
			return jsonResponse(policy, 201);
		});
		const res = await createPolicy('tok-1', 'new-id', 'Untitled Policy', '# Hello');
		expect(res.id).toBe('budget');
	});

	it('updatePolicy: PUT with only markdown_content', async () => {
		stubFetch(async (url, init) => {
			expect(url).toBe('/api/v1/policies/budget');
			expect(init.method).toBe('PUT');
			expect(JSON.parse(init.body as string)).toEqual({ markdown_content: '# Updated' });
			return jsonResponse({ ...policy, markdown_content: '# Updated' });
		});
		const res = await updatePolicy('tok-1', 'budget', '# Updated');
		expect(res.markdown_content).toBe('# Updated');
	});

	it('compilePolicy: POST /compile, parses {compiled_rego, warnings}', async () => {
		stubFetch(async (url, init) => {
			expect(url).toBe('/api/v1/policies/budget/compile');
			expect(init.method).toBe('POST');
			return jsonResponse({ compiled_rego: 'package budget\nallow = true', warnings: ['no-op'] });
		});
		const res = await compilePolicy('tok-1', 'budget');
		expect(res.compiled_rego).toContain('allow = true');
		expect(res.warnings).toEqual(['no-op']);
	});

	it('deployPolicy: POST /deploy, parses {status, deployed_at, message}', async () => {
		stubFetch(async (url) => {
			expect(url).toBe('/api/v1/policies/budget/deploy');
			return jsonResponse({ status: 'active', deployed_at: 1755093600000000000, message: 'ok' });
		});
		const res = await deployPolicy('tok-1', 'budget');
		expect(res.status).toBe('active');
		expect(res.deployed_at).toBe(1755093600000000000);
	});

	it('rollbackPolicy: POST /rollback', async () => {
		stubFetch(async (url) => {
			expect(url).toBe('/api/v1/policies/budget/rollback');
			return jsonResponse({ status: 'draft', message: 'Rolled back' });
		});
		const res = await rollbackPolicy('tok-1', 'budget');
		expect(res.status).toBe('draft');
	});

	it('deletePolicy: 204 returns undefined', async () => {
		stubFetch(async () => new Response(null, { status: 204 }));
		await expect(deletePolicy('tok-1', 'budget')).resolves.toBeUndefined();
	});

	it('surfaces backend {error, details} as ApiError with status and body', async () => {
		stubFetch(async () =>
			jsonResponse({ error: 'Policy already active', details: 'only draft can be deployed' }, 400)
		);
		await expect(deployPolicy('tok-1', 'budget')).rejects.toMatchObject({
			name: 'ApiError',
			status: 400,
			message: 'Policy already active',
			body: { error: 'Policy already active', details: 'only draft can be deployed' }
		});
	});

	it('keeps deploy 400 bodies (message/rolled_back) reachable on the error', async () => {
		stubFetch(async () =>
			jsonResponse(
				{ status: 'draft', error: 'MADE rejected policy: bad rego', rolled_back: true, message: 'Deployment failed. Rolled back.' },
				400
			)
		);
		try {
			await deployPolicy('tok-1', 'budget');
			expect.unreachable();
		} catch (e) {
			const err = e as ApiError;
			const body = err.body as { message?: string; rolled_back?: boolean };
			expect(body.message).toBe('Deployment failed. Rolled back.');
			expect(body.rolled_back).toBe(true);
		}
	});

	it('404 becomes ApiError with status 404', async () => {
		stubFetch(async () => jsonResponse({ error: 'Policy not found' }, 404));
		await expect(fetchPolicy('tok-1', 'ghost')).rejects.toMatchObject({ status: 404 });
	});

	it('network failure becomes ApiError with status 0 (connection lost)', async () => {
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		await expect(fetchPolicies('tok-1')).rejects.toMatchObject({
			status: 0,
			message: expect.stringContaining('Connection lost')
		});
	});

	it('extractApiError falls back through error/detail/message', () => {
		expect(extractApiError({ error: 'e' })).toBe('e');
		expect(extractApiError({ detail: 'd' })).toBe('d');
		expect(extractApiError({ message: 'm' })).toBe('m');
		expect(extractApiError(null)).toBe('Unknown error');
		expect(extractApiError('raw text')).toBe('Unknown error');
	});
});
