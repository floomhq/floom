"""Qualitative analysis agents: Coder, Analyst, Synthesizer."""

import logging
from typing import Dict, List, Any, Optional, Callable

from google import genai
from google.genai import types

from opendraft.qualitative.database import CodeDatabase

logger = logging.getLogger(__name__)

FunctionDeclaration = types.FunctionDeclaration


# --- Function Declarations for Qualitative Agents ---

add_code = FunctionDeclaration(
    name="add_code",
    description="Add a new code to the codebook. Returns the code_id.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Short code name (e.g., 'work-life-balance')"},
            "description": {"type": "string", "description": "Definition of what this code represents"},
            "parent_code": {"type": "string", "description": "Parent code_id for hierarchical coding (optional)"},
        },
        "required": ["name", "description"],
    },
)

get_code = FunctionDeclaration(
    name="get_code",
    description="Get details about a specific code by its ID.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "code_id": {"type": "string", "description": "Code ID (e.g., code_001)"},
        },
        "required": ["code_id"],
    },
)

query_codes = FunctionDeclaration(
    name="query_codes",
    description="Search for codes by keyword in name or description.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "keyword": {"type": "string", "description": "Keyword to search for"},
        },
        "required": ["keyword"],
    },
)

list_codes = FunctionDeclaration(
    name="list_codes",
    description="List all codes in the codebook with their frequencies.",
    parameters_json_schema={
        "type": "object",
        "properties": {},
    },
)

code_segment = FunctionDeclaration(
    name="code_segment",
    description="Apply one or more codes to a text segment. Creates a coded segment.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "source_id": {"type": "string", "description": "Source document/participant ID"},
            "text": {"type": "string", "description": "The exact text segment to code"},
            "codes": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of code_ids to apply"
            },
            "memo": {"type": "string", "description": "Researcher notes about this coding (optional)"},
        },
        "required": ["source_id", "text", "codes"],
    },
)

get_segments_by_code = FunctionDeclaration(
    name="get_segments_by_code",
    description="Get all text segments coded with a specific code.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "code_id": {"type": "string", "description": "Code ID to retrieve segments for"},
        },
        "required": ["code_id"],
    },
)

get_segments_by_source = FunctionDeclaration(
    name="get_segments_by_source",
    description="Get all coded segments from a specific source/participant.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "source_id": {"type": "string", "description": "Source/participant ID"},
        },
        "required": ["source_id"],
    },
)

get_code_frequency = FunctionDeclaration(
    name="get_code_frequency",
    description="Get frequency table of all codes, sorted by usage.",
    parameters_json_schema={
        "type": "object",
        "properties": {},
    },
)

get_cooccurrence = FunctionDeclaration(
    name="get_cooccurrence",
    description="Get code co-occurrence matrix showing which codes appear together.",
    parameters_json_schema={
        "type": "object",
        "properties": {},
    },
)

get_hierarchy = FunctionDeclaration(
    name="get_hierarchy",
    description="Get the hierarchical code structure (parent-child relationships).",
    parameters_json_schema={
        "type": "object",
        "properties": {},
    },
)

add_memo = FunctionDeclaration(
    name="add_memo",
    description="Add or update a memo/note for a coded segment.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "segment_id": {"type": "string", "description": "Segment ID to add memo to"},
            "memo": {"type": "string", "description": "Memo text"},
        },
        "required": ["segment_id", "memo"],
    },
)


# --- Operations Handler ---

class QualitativeOpsHandler:
    """Function handlers for qualitative coding operations."""

    def __init__(self, code_db: CodeDatabase):
        self.code_db = code_db

    def add_code(self, name: str, description: str, parent_code: Optional[str] = None) -> str:
        """Add a new code."""
        code_id = self.code_db.add_code(name, description, parent_code)
        return f"Created code {code_id}: {name}"

    def get_code(self, code_id: str) -> str:
        """Get code details."""
        code = self.code_db.get_code(code_id)
        if not code:
            return f"Code {code_id} not found"
        return f"Code {code_id}: {code.name}\nDescription: {code.description}\nFrequency: {code.frequency} segments across {code.sources} sources"

    def query_codes(self, keyword: str) -> str:
        """Search codes by keyword."""
        results = self.code_db.query_codes(keyword)
        if not results:
            return f"No codes found matching '{keyword}'"
        lines = [f"Found {len(results)} codes matching '{keyword}':"]
        for code in results:
            lines.append(f"  - {code.code_id}: {code.name} ({code.frequency} uses)")
        return "\n".join(lines)

    def list_codes(self) -> str:
        """List all codes."""
        codes = self.code_db.list_codes()
        if not codes:
            return "No codes in database"
        lines = ["Codebook:"]
        for c in codes:
            parent = f" (child of {c['parent']})" if c['parent'] else ""
            lines.append(f"  - {c['code_id']}: {c['name']}{parent} - {c['frequency']} uses")
        return "\n".join(lines)

    def code_segment(
        self, source_id: str, text: str, codes: List[str], memo: str = ""
    ) -> str:
        """Code a text segment."""
        segment_id = self.code_db.add_segment(source_id, text, codes, memo=memo)
        code_names = [self.code_db.get_code(c).name for c in codes if self.code_db.get_code(c)]
        return f"Created {segment_id}: '{text[:50]}...' coded with [{', '.join(code_names)}]"

    def get_segments_by_code(self, code_id: str) -> str:
        """Get segments for a code."""
        segments = self.code_db.get_segments_by_code(code_id)
        code = self.code_db.get_code(code_id)
        if not segments:
            return f"No segments coded with {code_id}"
        lines = [f"Segments coded with '{code.name}' ({len(segments)}):"]
        for seg in segments[:20]:  # Limit to 20
            text_preview = seg.text[:100] + "..." if len(seg.text) > 100 else seg.text
            lines.append(f"  [{seg.source_id}] {text_preview}")
            if seg.memo:
                lines.append(f"    Memo: {seg.memo}")
        if len(segments) > 20:
            lines.append(f"  ... and {len(segments) - 20} more")
        return "\n".join(lines)

    def get_segments_by_source(self, source_id: str) -> str:
        """Get segments from a source."""
        segments = self.code_db.get_segments_by_source(source_id)
        if not segments:
            return f"No coded segments from source {source_id}"
        lines = [f"Coded segments from {source_id} ({len(segments)}):"]
        for seg in segments:
            codes = [self.code_db.get_code(c).name for c in seg.codes if self.code_db.get_code(c)]
            text_preview = seg.text[:80] + "..." if len(seg.text) > 80 else seg.text
            lines.append(f"  [{', '.join(codes)}] {text_preview}")
        return "\n".join(lines)

    def get_code_frequency(self) -> str:
        """Get code frequency table."""
        freq_table = self.code_db.get_code_frequency_table()
        if not freq_table:
            return "No codes in database"
        lines = ["Code Frequency Table:"]
        lines.append("  Code | Frequency | Sources | Percent")
        lines.append("  " + "-" * 50)
        for row in freq_table[:20]:
            lines.append(f"  {row['name'][:20]:<20} | {row['frequency']:>5} | {row['sources']:>5} | {row['percent']:.1f}%")
        return "\n".join(lines)

    def get_cooccurrence(self) -> str:
        """Get co-occurrence matrix."""
        matrix = self.code_db.get_cooccurrence_matrix()
        if not matrix:
            return "No co-occurrence data"
        # Find pairs with co-occurrence > 0
        pairs = []
        for c1, row in matrix.items():
            for c2, count in row.items():
                if c1 < c2 and count > 0:  # Avoid duplicates
                    name1 = self.code_db.get_code(c1).name if self.code_db.get_code(c1) else c1
                    name2 = self.code_db.get_code(c2).name if self.code_db.get_code(c2) else c2
                    pairs.append((name1, name2, count))
        pairs.sort(key=lambda x: -x[2])
        if not pairs:
            return "No code co-occurrences found"
        lines = ["Code Co-occurrences:"]
        for name1, name2, count in pairs[:15]:
            lines.append(f"  {name1} + {name2}: {count} segments")
        return "\n".join(lines)

    def get_hierarchy(self) -> str:
        """Get hierarchical code structure."""
        hierarchy = self.code_db.get_hierarchy()

        def format_tree(node: Dict, indent: int = 0) -> List[str]:
            lines = []
            prefix = "  " * indent + ("└─ " if indent > 0 else "")
            lines.append(f"{prefix}{node['name']} ({node['frequency']})")
            for child in node.get('children', []):
                lines.extend(format_tree(child, indent + 1))
            return lines

        lines = ["Code Hierarchy:"]
        for root in hierarchy.get('codes', []):
            lines.extend(format_tree(root))
        return "\n".join(lines) if len(lines) > 1 else "No hierarchical codes"

    def add_memo(self, segment_id: str, memo: str) -> str:
        """Add memo to segment."""
        if self.code_db.add_memo(segment_id, memo):
            return f"Added memo to {segment_id}"
        return f"Segment {segment_id} not found"


# --- Agent Prompts ---

CODER_PROMPT = """You are a qualitative research coder. Your task is to systematically code interview transcripts or open-ended survey responses.

## Your Process
1. Read through the text segments carefully
2. Identify meaningful units of text (quotes, statements, ideas)
3. Create codes or apply existing codes to these segments
4. Use hierarchical coding when appropriate (child codes under parent themes)
5. Add memos to capture your analytical thinking

## Coding Guidelines
- Codes should be concise but descriptive (e.g., "work-life-balance" not "WLB")
- Include a clear definition for each new code
- Code the same concept consistently across all documents
- When in doubt, create a new code (you can merge later)
- Use the list_codes function frequently to maintain consistency

## Available Functions
- add_code: Create a new code in the codebook
- list_codes: See all existing codes
- query_codes: Search for existing codes by keyword
- code_segment: Apply codes to a text segment
- add_memo: Add analytical notes to a coded segment

When you have finished coding all provided text, respond with SIGNAL: DONE"""

ANALYST_PROMPT = """You are a qualitative data analyst. Your task is to analyze patterns in coded data.

## Your Process
1. Review the codebook and code frequencies
2. Identify patterns and relationships between codes
3. Examine co-occurrence patterns (which codes appear together)
4. Compare coding across different sources/participants
5. Generate thematic summaries

## Analysis Guidelines
- Look for both common patterns AND notable exceptions
- Consider the frequency AND distribution of codes
- Pay attention to co-occurring codes (they may form themes)
- Use the hierarchy to identify overarching themes
- Note any surprising findings or contradictions

## Available Functions
- list_codes: See all codes with frequencies
- get_code_frequency: Get detailed frequency table
- get_cooccurrence: See which codes appear together
- get_hierarchy: View the code hierarchy/structure
- get_segments_by_code: Read actual quotes for a code
- get_segments_by_source: See all codes for a participant

When you have completed your analysis, provide a structured summary and respond with SIGNAL: DONE"""

SYNTHESIZER_PROMPT = """You are a qualitative findings synthesizer. Your task is to write up the findings from coded qualitative data.

## Your Process
1. Review the analysis of codes and themes
2. Identify the main themes supported by the data
3. Select representative quotes for each theme
4. Write a coherent narrative synthesis
5. Note limitations and areas for further investigation

## Writing Guidelines
- Ground all claims in the coded data
- Use direct quotes to illustrate points
- Preserve participant voice and context
- Balance breadth (themes) with depth (quotes)
- Be transparent about data saturation and coverage

## Available Functions
- list_codes: See the codebook
- get_code_frequency: Understand prevalence
- get_segments_by_code: Get quotes for themes
- get_hierarchy: See thematic structure

When you have written the synthesis, respond with SIGNAL: DONE"""


def get_coder_tools() -> List[FunctionDeclaration]:
    """Get function declarations for the Coder agent."""
    return [
        add_code,
        get_code,
        query_codes,
        list_codes,
        code_segment,
        get_segments_by_code,
        add_memo,
    ]


def get_analyst_tools() -> List[FunctionDeclaration]:
    """Get function declarations for the Analyst agent."""
    return [
        list_codes,
        get_code,
        query_codes,
        get_code_frequency,
        get_cooccurrence,
        get_hierarchy,
        get_segments_by_code,
        get_segments_by_source,
    ]


def get_synthesizer_tools() -> List[FunctionDeclaration]:
    """Get function declarations for the Synthesizer agent."""
    return [
        list_codes,
        get_code,
        get_code_frequency,
        get_hierarchy,
        get_segments_by_code,
    ]


# --- Agent Classes ---

class QualitativeAgent:
    """
    Base agent for qualitative analysis using Gemini function calling.

    Simplified version of BaseCodeAgent for qualitative-specific tasks.
    """

    def __init__(
        self,
        name: str,
        system_prompt: str,
        function_declarations: List[FunctionDeclaration],
        function_handlers: Dict[str, Callable],
        model_name: str = "gemini-3-flash-preview",
        max_iterations: int = 50,
        client: Optional[genai.Client] = None,
    ):
        self.name = name
        self.system_prompt = system_prompt
        self.function_declarations = function_declarations
        self.function_handlers = function_handlers
        self.model_name = model_name
        self.max_iterations = max_iterations

        # Initialize client
        if client:
            self.client = client
        else:
            from opendraft.config import get_config
            config = get_config()
            self.client = genai.Client(
                api_key=config.google_api_key,
                http_options={"timeout": 120_000},
            )

    def run(self, task: str) -> Dict[str, Any]:
        """
        Run the agent on a task.

        Returns dict with:
        - status: 'done', 'max_iterations', or 'error'
        - response: final text response
        - iterations: number of iterations used
        """
        # Build config with tools
        config = types.GenerateContentConfig(
            system_instruction=self.system_prompt,
            tools=[types.Tool(function_declarations=self.function_declarations)],
        )

        # Start chat
        chat = self.client.chats.create(model=self.model_name, config=config)

        iteration = 0
        final_response = ""

        while iteration < self.max_iterations:
            iteration += 1

            # Send message
            if iteration == 1:
                response = chat.send_message(task)
            else:
                # Continue conversation
                response = chat.send_message("Continue.")

            # Process response parts
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    final_response = part.text
                    # Check for DONE signal
                    if "SIGNAL: DONE" in part.text or "DONE" in part.text:
                        return {
                            "status": "done",
                            "response": final_response.replace("SIGNAL: DONE", "").strip(),
                            "iterations": iteration,
                        }

                elif hasattr(part, 'function_call') and part.function_call:
                    # Handle function call
                    fc = part.function_call
                    func_name = fc.name
                    func_args = dict(fc.args) if fc.args else {}

                    logger.debug("[%s] Calling %s(%s)", self.name, func_name, func_args)

                    if func_name in self.function_handlers:
                        try:
                            result = self.function_handlers[func_name](**func_args)
                        except Exception as e:
                            result = f"Error: {e}"
                    else:
                        result = f"Unknown function: {func_name}"

                    # Send function result back
                    chat.send_message(
                        types.Part.from_function_response(
                            name=func_name,
                            response={"result": str(result)},
                        )
                    )

        return {
            "status": "max_iterations",
            "response": final_response,
            "iterations": iteration,
        }


class CoderAgent(QualitativeAgent):
    """Agent for coding qualitative data."""

    def __init__(
        self,
        code_db: CodeDatabase,
        model_name: str = "gemini-3-flash-preview",
        client: Optional[genai.Client] = None,
    ):
        ops = QualitativeOpsHandler(code_db)
        handlers = {
            "add_code": ops.add_code,
            "get_code": ops.get_code,
            "query_codes": ops.query_codes,
            "list_codes": ops.list_codes,
            "code_segment": ops.code_segment,
            "get_segments_by_code": ops.get_segments_by_code,
            "add_memo": ops.add_memo,
        }

        super().__init__(
            name="coder",
            system_prompt=CODER_PROMPT,
            function_declarations=get_coder_tools(),
            function_handlers=handlers,
            model_name=model_name,
            max_iterations=100,  # Coding can take many iterations
            client=client,
        )


class AnalystAgent(QualitativeAgent):
    """Agent for analyzing coded qualitative data."""

    def __init__(
        self,
        code_db: CodeDatabase,
        model_name: str = "gemini-3-flash-preview",
        client: Optional[genai.Client] = None,
    ):
        ops = QualitativeOpsHandler(code_db)
        handlers = {
            "list_codes": ops.list_codes,
            "get_code": ops.get_code,
            "query_codes": ops.query_codes,
            "get_code_frequency": ops.get_code_frequency,
            "get_cooccurrence": ops.get_cooccurrence,
            "get_hierarchy": ops.get_hierarchy,
            "get_segments_by_code": ops.get_segments_by_code,
            "get_segments_by_source": ops.get_segments_by_source,
        }

        super().__init__(
            name="analyst",
            system_prompt=ANALYST_PROMPT,
            function_declarations=get_analyst_tools(),
            function_handlers=handlers,
            model_name=model_name,
            max_iterations=30,
            client=client,
        )


class SynthesizerAgent(QualitativeAgent):
    """Agent for synthesizing qualitative findings."""

    def __init__(
        self,
        code_db: CodeDatabase,
        model_name: str = "gemini-3-flash-preview",
        client: Optional[genai.Client] = None,
    ):
        ops = QualitativeOpsHandler(code_db)
        handlers = {
            "list_codes": ops.list_codes,
            "get_code": ops.get_code,
            "get_code_frequency": ops.get_code_frequency,
            "get_hierarchy": ops.get_hierarchy,
            "get_segments_by_code": ops.get_segments_by_code,
        }

        super().__init__(
            name="synthesizer",
            system_prompt=SYNTHESIZER_PROMPT,
            function_declarations=get_synthesizer_tools(),
            function_handlers=handlers,
            model_name=model_name,
            max_iterations=20,
            client=client,
        )
