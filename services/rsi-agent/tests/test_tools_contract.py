"""Exercise the HTTP tool adapter without loading or calling a model SDK."""
import asyncio
import importlib.util
import inspect
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
tool_module = types.ModuleType('openjiuwen.core.foundation.tool')
tool_module.Tool = object
tool_module.tool = lambda **kwargs: lambda function: function
sys.modules['openjiuwen.core.foundation.tool'] = tool_module
spec = importlib.util.spec_from_file_location('rsi_tools_contract', ROOT / 'app' / 'tools.py')
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)


class ToolContract(unittest.IsolatedAsyncioTestCase):
    async def test_a6_forwards_cluster_targets_and_original_training_case(self):
        client = tools.RsiApiClient('http://fixture')
        client._get = AsyncMock(return_value={'improved': True})
        await client.probe('模糊业务', op='A6_ambiguity_cluster_expand', targets=['a', 'b'], case_id='train')
        params = client._get.call_args.args[1]
        self.assertEqual(params['targets'], 'a||b')
        self.assertEqual(params['caseId'], 'train')
        probe = tools.create_rsi_tools(client)[-1]
        self.assertIn('targets', inspect.signature(probe).parameters)

    async def test_weakness_metadata_and_capabilities_survive_http_envelope(self):
        response = types.SimpleNamespace(raise_for_status=lambda: None, json=lambda: {
            'data': [{'family': 'ambiguous'}], 'capabilities': {'graphOperators': {'A6': 'shared'}}, 'controls': [{'case_id': 'ok'}]})
        client = tools.RsiApiClient('http://fixture')
        client._client = types.SimpleNamespace(is_closed=False, get=AsyncMock(return_value=response))
        result = await client.weaknesses()
        self.assertIn('capabilities', result)
        self.assertEqual(result['controls'][0]['case_id'], 'ok')

    def test_bundled_proposal_contract_only_teaches_executable_graph_operators(self):
        prompt = (ROOT / 'skills' / 'proposal' / 'SKILL.prompt').read_text(encoding='utf-8')
        self.assertIn('A6_ambiguity_cluster_expand', prompt)
        for unsupported in ['A6_add_intent', 'A7_merge_intent', 'A8_relation_edit', 'targetTracking.improved=true']:
            self.assertNotIn(unsupported, prompt)


if __name__ == '__main__':
    unittest.main()
