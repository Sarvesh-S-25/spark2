import { pascal, snake } from '../../util.js';
import {
  banner, fieldsOf, unwrapArray, pyScalar,
  type LanguagePack, type GenContract, type GenFile,
} from '../pack.js';

const OUT = 'server/spark';

const modelBase = (key: string) => pascal(key.replace(/\./g, '_'));
const fileBase = (key: string) => snake(key);

/**
 * Python + FastAPI + Pydantic.
 *
 * The second backend pack exists mostly to prove the interface is real: adding
 * a language must not require touching SparkX core. Everything here is the same
 * five methods the Node pack implements, rendering different text.
 */
export const pythonFastapi: LanguagePack = {
  id: 'python-fastapi',
  label: 'Python · FastAPI · Pydantic',
  lane: 'backend',

  emitRuntime(): GenFile[] {
    const body = `
from fastapi import HTTPException


class NotImplementedContract(HTTPException):
    """Raised by every un-implemented handler."""

    def __init__(self, contract: str) -> None:
        super().__init__(status_code=501, detail={"code": "NOT_IMPLEMENTED", "message": f"{contract} is not implemented yet"})


class ContractError(HTTPException):
    """An error the contract declares. Anything else is a 500 and your bug."""

    def __init__(self, code: str, status: int, message: str | None = None) -> None:
        super().__init__(status_code=status, detail={"code": code, "message": message or code})
`.trimStart();

    return [{
      path: `${OUT}/runtime.py`,
      content: banner('#', { note: 'Shared runtime for every generated router.' }, body),
    }];
  },

  emitTypes(contracts: GenContract[]): GenFile[] {
    const blocks: string[] = [];

    const model = (name: string, schema: any): string => {
      const fields = fieldsOf(schema);
      if (fields.length === 0) return `class ${name}(BaseModel):\n    pass`;
      const lines = fields.map(({ name: f, prop, required }) => {
        const t = pyScalar(prop);
        const doc = prop.description ? `  # ${prop.description}` : '';
        return required
          ? `    ${snake(f)}: ${t}${doc}`
          : `    ${snake(f)}: Optional[${t}] = None${doc}`;
      });
      return `class ${name}(BaseModel):\n${lines.join('\n')}`;
    };

    for (const c of contracts) {
      if (c.kind === 'type') {
        blocks.push(model(c.spec.transport.symbol || modelBase(c.key), c.spec.output));
        continue;
      }
      const base = modelBase(c.key);
      if (fieldsOf(c.spec.input).length > 0) blocks.push(model(`${base}Input`, c.spec.input));
      const { isArray } = unwrapArray(c.spec.output);
      blocks.push(model(isArray ? `${base}Item` : `${base}Output`, c.spec.output));
      if (isArray) blocks.push(`${base}Output = List[${base}Item]`);
    }

    const body = `
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


${blocks.join('\n\n\n')}
`.trimStart();

    return [{
      path: `${OUT}/models.py`,
      content: banner('#', { note: 'Every contract shape as a Pydantic model.' }, body),
    }];
  },

  emitClient(): GenFile[] {
    return [];
  },

  emitServerStub(c: GenContract): GenFile[] {
    if (c.kind !== 'http' && c.kind !== 'config') return [];

    const base = modelBase(c.key);
    const fn = snake(c.key);
    const method = (c.spec.transport.method || 'GET').toLowerCase();
    const path = (c.spec.transport.path || `/api/${c.key.replace(/\./g, '/')}`)
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const hasInput = fieldsOf(c.spec.input).length > 0;
    const { isArray } = unwrapArray(c.spec.output);
    const returnType = isArray ? `List[models.${base}Item]` : `models.${base}Output`;

    const body = `
from typing import List

from fastapi import APIRouter

from .. import models
from ..runtime import NotImplementedContract

router = APIRouter()

CONTRACT = "${c.key}"

# ${c.spec.summary || c.key}
# ${method.toUpperCase()} ${path}
#
# Error codes this contract may return:
${c.spec.errors.map((e) => `#   ${e.code} (${e.http}) — ${e.when || 'unspecified'}`).join('\n') || '#   (none declared)'}


@router.${method}("${path}")
async def ${fn}(${hasInput ? `payload: models.${base}Input | None = None` : ''}) -> ${returnType}:
    raise NotImplementedContract(CONTRACT)
`.trimStart();

    return [{
      path: `${OUT}/routers/${fileBase(c.key)}.py`,
      content: banner('#', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
    }];
  },

  emitMocks(): GenFile[] {
    return [];
  },

  emitContractTest(c: GenContract): GenFile[] {
    if (c.kind !== 'http' && c.kind !== 'config') return [];
    const example = c.examples[0];
    if (!example) return [];
    const { isArray } = unwrapArray(c.spec.output);
    const required = fieldsOf(c.spec.output).filter((f) => f.required).map((f) => snake(f.name));

    const body = `
import pytest

from ..routers import ${fileBase(c.key)} as route

# Generated from the contract's example — the same one the frontend mocks.
EXAMPLE_INPUT = ${toPy(example.input)}


@pytest.mark.asyncio
async def test_${fileBase(c.key)}_matches_contract() -> None:
    result = await route.${snake(c.key)}(EXAMPLE_INPUT)
${isArray
        ? `    assert isinstance(result, list)
    first = result[0] if result else {}`
        : `    first = result`}
${required.map((k) => `    assert hasattr(first, "${k}") or "${k}" in first`).join('\n') || '    # contract declares no required output fields'}
`.trimStart();

    return [{
      path: `${OUT}/tests/test_${fileBase(c.key)}.py`,
      content: banner('#', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
    }];
  },
};

/** JSON → Python literal. */
function toPy(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => `${indent}    ${toPy(v, indent + '    ')}`).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${indent}    ${JSON.stringify(snake(k))}: ${toPy(v, indent + '    ')}`).join(',\n')}\n${indent}}`;
}
