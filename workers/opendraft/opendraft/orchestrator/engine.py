"""Adaptive orchestrator: runs 5-phase agent pipeline with rerun support."""

import logging
import os
import threading
from pathlib import Path
from typing import Callable, Optional
from queue import Queue, Empty

from google import genai

from opendraft.config import get_config
from opendraft.orchestrator.state import SharedState, AgentResult
from opendraft.orchestrator.checkpoint import (
    CheckpointManager,
    PipelineCheckpoint,
    serialize_shared_state,
    deserialize_shared_state,
)
from opendraft.citations.database import save_citation_database
from opendraft.agents.researcher import ResearcherAgent
from opendraft.agents.architect import ArchitectAgent
from opendraft.agents.writer import WriterAgent
from opendraft.agents.validator import ValidatorAgent
from opendraft.agents.refiner import RefinerAgent
from opendraft.agents.base import SIGNAL_DONE, SIGNAL_RERUN, SIGNAL_ESCALATE
from opendraft.functions.academic_search import cleanup_clients
from opendraft.analytics import score_draft
from opendraft.analytics.quality_scorer import RegressionTracker
from opendraft.citations import run_citation_claim_verification

logger = logging.getLogger(__name__)

# Quality gate threshold - skip LLM refinement if score >= this
QUALITY_GATE_THRESHOLD = 85.0

# Global regression tracker for quality history
_regression_tracker: Optional[RegressionTracker] = None

def get_regression_tracker() -> RegressionTracker:
    """Get or create the global regression tracker."""
    global _regression_tracker
    if _regression_tracker is None:
        _regression_tracker = RegressionTracker()
    return _regression_tracker

# Phase definitions
PHASES = [
    ("researcher", "Research & Citation Discovery"),
    ("architect", "Outline & Structure Design"),
    ("writer", "Draft Writing"),
    ("validator", "Validation & Verification"),
    ("refiner", "Final Polish & Compilation"),
]

MAX_RERUNS_PER_PHASE = 2

# Per-agent timeout in seconds
AGENT_TIMEOUTS = {
    "researcher": 300,  # 5 min
    "architect": 120,   # 2 min
    "writer": 900,      # 15 min
    "validator": 300,   # 5 min
    "refiner": 300,     # 5 min
}


def _parse_timeout_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        logger.warning("Invalid timeout env %s=%r, using %.1fs", name, value, default)
        return default
    if parsed <= 0:
        logger.warning("Non-positive timeout env %s=%r, using %.1fs", name, value, default)
        return default
    return parsed


def resolve_agent_timeout(agent_name: str) -> float:
    """Resolve agent timeout from defaults with optional env overrides."""
    default = AGENT_TIMEOUTS.get(agent_name, 300.0)
    specific_key = f"OPENDRAFT_AGENT_TIMEOUT_{agent_name.upper()}"
    if os.getenv(specific_key) is not None:
        return _parse_timeout_env(specific_key, float(default))
    return _parse_timeout_env("OPENDRAFT_AGENT_TIMEOUT_SECONDS", float(default))


class Orchestrator:
    """
    Adaptive orchestrator that runs the 5-phase agent pipeline.

    Handles:
    - Sequential phase execution
    - RERUN signals (jump back to previous agent, max 2 per phase)
    - ESCALATE signals (log and continue)
    - Context passing between agents via SharedState
    """

    def __init__(
        self,
        state: SharedState,
        model_name: Optional[str] = None,
        on_phase_start: Optional[Callable] = None,
        on_phase_complete: Optional[Callable] = None,
        on_write: Optional[Callable[[str, int], None]] = None,
        enable_checkpoints: bool = True,
    ):
        self.state = state
        config = get_config()
        self.model_name = model_name or config.gemini_model
        self.on_phase_start = on_phase_start
        self.on_phase_complete = on_phase_complete
        self.on_write = on_write  # Callback for file writes: on_write(filename, word_count)
        self.rerun_counts: dict = {}
        self.completed_phases: list[str] = []

        # V3.2: Checkpoint support
        self.enable_checkpoints = enable_checkpoints
        self.checkpoint_manager = CheckpointManager() if enable_checkpoints else None

        # Create Gemini client (instance-based in new SDK)
        self.client = genai.Client(api_key=config.google_api_key)

    def _create_agent(self, agent_name: str):
        """Create an agent instance by name."""
        agent_map = {
            "researcher": ResearcherAgent,
            "architect": ArchitectAgent,
            "writer": WriterAgent,
            "validator": ValidatorAgent,
            "refiner": RefinerAgent,
        }
        agent_cls = agent_map[agent_name]

        # Pass on_write callback to writer agent
        if agent_name == "writer" and self.on_write:
            return agent_cls(state=self.state, model_name=self.model_name, on_write=self.on_write)

        return agent_cls(state=self.state, model_name=self.model_name)

    def _run_agent_once(self, agent_name: str, timeout: float) -> AgentResult:
        """Run an agent with the given timeout. Returns AgentResult."""
        agent = self._create_agent(agent_name)
        context = self.state.get_context_for_agent(agent_name)
        task = self._build_task(agent_name)
        queue: Queue[tuple[str, object]] = Queue(maxsize=1)

        def _worker():
            try:
                queue.put(("ok", agent.run(task=task, context=context)))
            except Exception as exc:
                queue.put(("err", exc))

        worker = threading.Thread(
            target=_worker,
            daemon=True,
            name=f"orchestrator-{agent_name}",
        )
        worker.start()
        worker.join(timeout=timeout)

        if worker.is_alive():
            logger.warning("Agent %s timed out after %ss", agent_name, timeout)
            partial_cost = agent.get_cost() if hasattr(agent, 'get_cost') else {}
            return AgentResult(
                agent_name=agent_name,
                signal=SIGNAL_DONE,
                output=f"[Agent {agent_name} timed out after {timeout}s]",
                metadata={"timed_out": True, "cost": partial_cost},
            )

        try:
            status, payload = queue.get_nowait()
        except Empty:
            partial_cost = agent.get_cost() if hasattr(agent, 'get_cost') else {}
            return AgentResult(
                agent_name=agent_name,
                signal=SIGNAL_ESCALATE,
                output=f"[Agent {agent_name} failed without producing a result]",
                rerun_reason="agent worker exited without result",
                metadata={"cost": partial_cost},
            )

        if status == "err":
            raise payload
        return payload  # type: ignore[return-value]

    def _run_agent(self, agent_name: str) -> AgentResult:
        """Run agent with automatic retry on timeout (50% extended)."""
        timeout = resolve_agent_timeout(agent_name)
        result = self._run_agent_once(agent_name, timeout)

        if result.metadata and result.metadata.get("timed_out"):
            extended = timeout * 1.5
            logger.info("Retrying agent %s with extended timeout %ss", agent_name, extended)
            result = self._run_agent_once(agent_name, extended)

        return result

    def _save_checkpoint(self, current_phase: str) -> None:
        """Save a checkpoint after phase completion.

        Args:
            current_phase: The phase that just completed
        """
        if not self.enable_checkpoints or not self.checkpoint_manager:
            return

        try:
            checkpoint = PipelineCheckpoint(
                run_id=self.state.run_id,
                topic=self.state.topic,
                current_phase=current_phase,
                completed_phases=self.completed_phases.copy(),
                shared_state=serialize_shared_state(self.state),
                model_name=self.model_name,
                citation_style=self.state.citation_db.citation_style,
                draft_language=self.state.citation_db.draft_language,
                workspace_path=str(self.state.workspace_dir.absolute()),
            )
            self.checkpoint_manager.save(checkpoint)
        except Exception as e:
            logger.warning("Failed to save checkpoint: %s", e)

    def _delete_checkpoint(self) -> None:
        """Delete checkpoint after successful completion."""
        if not self.enable_checkpoints or not self.checkpoint_manager:
            return

        try:
            self.checkpoint_manager.delete(self.state.run_id)
        except Exception as e:
            logger.warning("Failed to delete checkpoint: %s", e)

    @classmethod
    def resume_from_checkpoint(
        cls,
        run_id: str,
        on_phase_start: Optional[Callable] = None,
        on_phase_complete: Optional[Callable] = None,
    ) -> Optional["Orchestrator"]:
        """Resume a pipeline from a checkpoint.

        Args:
            run_id: The run ID to resume
            on_phase_start: Optional callback when phase starts
            on_phase_complete: Optional callback when phase completes

        Returns:
            Orchestrator instance ready to resume, or None if checkpoint not found
        """
        checkpoint_manager = CheckpointManager()
        checkpoint = checkpoint_manager.load(run_id)

        if not checkpoint:
            logger.warning("No checkpoint found for run_id: %s", run_id)
            return None

        # Restore workspace directory
        workspace_dir = Path(checkpoint.workspace_path) if checkpoint.workspace_path else Path("workspace")
        workspace_dir.mkdir(parents=True, exist_ok=True)

        # Restore SharedState from checkpoint
        state = deserialize_shared_state(checkpoint.shared_state, workspace_dir)

        # Create orchestrator with restored state
        orchestrator = cls(
            state=state,
            model_name=checkpoint.model_name,
            on_phase_start=on_phase_start,
            on_phase_complete=on_phase_complete,
            enable_checkpoints=True,
        )
        orchestrator.completed_phases = checkpoint.completed_phases.copy()

        logger.info(
            "Resumed run %s from phase '%s'. Completed phases: %s",
            run_id, checkpoint.current_phase, ', '.join(checkpoint.completed_phases) or 'none'
        )

        return orchestrator

    def _run_quality_gate(self) -> None:
        """Run quality scoring on the draft after writer phase.

        Sets state.quality_score and state.skip_llm_refine based on results.
        """
        draft_path = self.state.workspace_dir / "draft.md"
        if not draft_path.exists():
            logger.warning("Quality gate: draft.md not found, skipping quality check")
            return

        try:
            draft_content = draft_path.read_text(encoding='utf-8')
            if not draft_content.strip():
                logger.warning("Quality gate: draft.md is empty, skipping quality check")
                return

            score_result = score_draft(draft_content)
            self.state.quality_score = score_result
            self.state.skip_llm_refine = score_result['passes_gate']

            # Log quality gate results
            overall = score_result['overall_score']
            passes = "PASS" if score_result['passes_gate'] else "FAIL"
            logger.info(
                "Quality Gate: %.1f%% (%s) | TTR=%.3f, Variety=%.0f%%, Citations=%.1f/¶",
                overall, passes, score_result['raw_metrics']['ttr'],
                score_result['component_scores']['sentence_variety'],
                score_result['raw_metrics']['citation_density']['density']
            )

            if score_result['passes_gate']:
                logger.info("Quality gate PASSED: LLM refinement will be skipped")
            else:
                logger.info(
                    "Quality gate FAILED (%.1f%% < %s%%): LLM refinement will be applied",
                    overall, QUALITY_GATE_THRESHOLD
                )
                # Log recommendations
                for rec in score_result.get('recommendations', [])[:3]:
                    logger.info("  → %s: %s", rec['issue'], rec['action'])

            # Store in run metadata
            self.state.run_metadata['quality_score'] = overall
            self.state.run_metadata['quality_gate_passed'] = score_result['passes_gate']
            self.state.run_metadata['quality_breakdown'] = score_result['component_scores']

        except Exception as e:
            logger.error("Quality gate error: %s", e)
            # On error, don't skip LLM refine (safer default)
            self.state.skip_llm_refine = False

    def _run_citation_claim_verification(self) -> None:
        """Run citation-claim semantic verification after validation.

        Verifies that citations semantically match the claims they support.
        Results are saved to qa_citation_verification.md in the workspace.
        """
        config = get_config()
        if not config.enable_citation_verification:
            logger.info("[QA] Citation-claim verification disabled — skipping")
            return

        draft_path = self.state.workspace_dir / "draft.md"
        if not draft_path.exists():
            logger.warning("[QA] Citation verification: draft.md not found, skipping")
            return

        try:
            draft_content = draft_path.read_text(encoding='utf-8')
            if not draft_content.strip():
                logger.warning("[QA] Citation verification: draft.md is empty, skipping")
                return

            # Check if there are any citations to verify
            if not self.state.citation_db.citations:
                logger.info("[QA] Citation verification: no citations in database, skipping")
                return

            logger.info("[QA] Running citation-claim semantic verification...")

            result = run_citation_claim_verification(
                draft_text=draft_content,
                citation_db=self.state.citation_db,
                max_pairs=25,
            )

            # Save report
            report_path = self.state.workspace_dir / "qa_citation_verification.md"
            report_path.write_text(result['report'], encoding='utf-8')

            # Log summary
            stats = result['stats']
            logger.info(
                "[QA] Citation verification complete: %s relevant, %s mismatched, %s uncertain (of %s pairs)",
                stats['relevant'], stats['irrelevant'], stats['uncertain'], stats['total_pairs']
            )

            # Store in run metadata
            self.state.run_metadata['citation_verification'] = {
                'total_pairs': stats['total_pairs'],
                'relevant': stats['relevant'],
                'irrelevant': stats['irrelevant'],
                'uncertain': stats['uncertain'],
            }

            # Flag issues if there are mismatches
            if stats['irrelevant'] > 0:
                logger.warning(
                    "[QA] Found %s citation-claim mismatch(es). See qa_citation_verification.md for details.",
                    stats['irrelevant']
                )

        except Exception as e:
            logger.error("[QA] Citation verification error: %s", e)
            # Non-fatal: don't block the pipeline on verification errors

    def _build_task(self, agent_name: str) -> str:
        """Build the task prompt for an agent based on current state."""
        topic = self.state.topic

        if agent_name == "researcher":
            return (
                f"Research the following topic and find 15-30 high-quality academic citations:\n\n"
                f"**Topic**:\n```\n{topic}\n```\n\n"
                f"Search across multiple databases (Semantic Scholar, Crossref) and use Google Search "
                f"for industry reports and government publications. Add each relevant paper to the "
                f"citation database with complete metadata."
            )
        elif agent_name == "architect":
            return (
                f"Design an academic paper outline for:\n\n"
                f"**Topic**:\n```\n{topic}\n```\n\n"
                f"Review all available citations in the database, identify a TENSION, PARADOX, or GAP "
                f"in the literature, and formulate a specific thesis (an arguable claim, not a topic survey).\n\n"
                f"REQUIREMENTS:\n"
                f"- Use the 6-section academic structure: Introduction, Literature Review, Methodology, Analysis, Discussion, Conclusion\n"
                f"- Include a clear thesis statement and paper type declaration\n"
                f"- Include an Argument Flow Map showing how each section advances the thesis\n"
                f"- Include an Evidence Placement Table mapping citations to sections with roles\n"
                f"- Include Table Planning: specify 2-3 comparison tables with location, purpose, and column headers\n"
                f"- Include Cross-Reference Notes: 2-3 places where later sections reference earlier ones\n"
                f"- Word count targets as HTML comments below headings (e.g., `<!-- target: 600 words -->`), NOT in heading text\n"
                f"- At least 3 heading levels in body sections (##, ###, ####)\n"
                f"- Save as outline.md"
            )
        elif agent_name == "writer":
            return (
                f"Write the complete academic draft based on the outline.\n\n"
                f"**Topic**:\n```\n{topic}\n```\n\n"
                f"Read the outline from outline.md (including thesis, table planning, and cross-reference notes), "
                f"then write each section following the Paragraph Architecture rule:\n"
                f"Topic sentence (8-15 words) → Evidence (1-2 sentences with citation) → Analysis (1-2 sentences) → Connection.\n\n"
                f"REQUIREMENTS:\n"
                f"- Follow the 6-section academic structure from the outline\n"
                f"- Include comparison tables as specified in the outline's Table Planning\n"
                f"- Include at least 3 cross-references between sections (e.g., 'As discussed in Section 2.1...')\n"
                f"- Vary sentence length: mix short (8-12 words) with longer (20-30 words). Never 3+ similar-length sentences in a row.\n"
                f"- No padding: if a section is short, add ONE new paragraph with a NEW idea. Max 1 expansion attempt.\n"
                f"- Include a Methodology section declaring 'narrative review' with honest limitations\n"
                f"- Save each section as section_N.md, then call compile_draft('draft.md')"
            )
        elif agent_name == "validator":
            return (
                "Validate the draft for citation accuracy and quality.\n\n"
                "Read draft.md, verify all citations, check DOIs, fact-check key claims, "
                "and write a validation report to validation_report.md."
            )
        elif agent_name == "refiner":
            # V3: Include quality gate status in refiner task
            quality_info = ""
            if self.state.quality_score:
                score = self.state.quality_score['overall_score']
                gate_status = "PASSED" if self.state.skip_llm_refine else "FAILED"
                quality_info = (
                    f"\n\n**QUALITY GATE STATUS**: {gate_status} ({score:.1f}%)\n"
                )
                if self.state.skip_llm_refine:
                    quality_info += (
                        "The draft quality is sufficient — proceed with standard deterministic cleanup only. "
                        "LLM refinement is NOT needed.\n"
                    )
                else:
                    quality_info += (
                        "The draft needs quality improvement. After clean_draft(), consider calling "
                        "llm_refine() if the score is still below 85%.\n"
                    )

            return (
                f"Polish and finalize the draft. Follow these steps in order:\n\n"
                f"1. Read outline.md (get thesis and paper type), draft.md (skim structure), "
                f"and validation_report.md (if exists)\n"
                f"2. Call clean_draft('draft.md', 'draft_clean.md') — server-side prose cleanup "
                f"(strips fillers, intensifiers, verbose phrases, meta-commentary, duplicate headings)\n"
                f"3. Write frontmatter.md with YAML frontmatter + 150-250 word structured abstract via write_file\n"
                f"4. Call finalize_draft('draft_clean.md', 'final_draft.md') — compiles citations, "
                f"prepends frontmatter, appends bibliography\n"
                f"5. Read first 50 lines of final_draft.md to verify frontmatter + abstract are present"
                f"{quality_info}"
            )

    def run(self) -> str:
        """
        Run the full 5-phase pipeline.

        Returns:
            The final draft text.
        """
        # V3.2: Skip already completed phases (for resume)
        phase_index = 0
        while phase_index < len(PHASES) and PHASES[phase_index][0] in self.completed_phases:
            logger.info("Skipping completed phase: %s", PHASES[phase_index][0])
            phase_index += 1

        while phase_index < len(PHASES):
            agent_name, phase_desc = PHASES[phase_index]
            self.state.current_phase = agent_name

            if self.on_phase_start:
                self.on_phase_start(phase_index + 1, len(PHASES), agent_name, phase_desc)

            logger.info("Phase %s/%s: %s (%s)", phase_index + 1, len(PHASES), phase_desc, agent_name)

            result = self._run_agent(agent_name)
            self.state.add_result(result)

            if self.on_phase_complete:
                self.on_phase_complete(phase_index + 1, len(PHASES), agent_name, result)

            # Persist citation DB after each phase
            if self.state.citation_db.citations:
                db_path = self.state.workspace_dir / "citation_database.json"
                try:
                    save_citation_database(self.state.citation_db, db_path)
                except Exception as e:
                    logger.warning("Failed to save citation DB: %s", e)

            # Handle signals
            if result.signal == SIGNAL_DONE:
                logger.info("Agent %s: DONE", agent_name)

                # V3: Run quality gate after writer phase
                if agent_name == "writer":
                    self._run_quality_gate()

                # V3: Run citation-claim verification after validator phase
                if agent_name == "validator":
                    self._run_citation_claim_verification()

                # V3.2: Track completed phase and save checkpoint
                self.completed_phases.append(agent_name)
                self._save_checkpoint(agent_name)

                phase_index += 1

            elif result.signal == SIGNAL_RERUN:
                target = result.rerun_target or agent_name
                rerun_key = f"{agent_name}->{target}"
                self.rerun_counts[rerun_key] = self.rerun_counts.get(rerun_key, 0) + 1

                if self.rerun_counts[rerun_key] <= MAX_RERUNS_PER_PHASE:
                    logger.info("Agent %s requests RERUN of %s: %s", agent_name, target, result.rerun_reason)
                    # Run ONLY the target agent, then return to current phase
                    rerun_result = self._run_agent(target)
                    self.state.add_result(rerun_result)
                    # phase_index stays the same — loop re-executes the requesting agent
                else:
                    logger.warning(
                        "Max reruns exceeded for %s (%s). Continuing.",
                        rerun_key, self.rerun_counts[rerun_key]
                    )
                    self.completed_phases.append(agent_name)
                    self._save_checkpoint(agent_name)
                    phase_index += 1

            elif result.signal == SIGNAL_ESCALATE:
                logger.warning("Agent %s ESCALATED: %s", agent_name, result.rerun_reason)
                # Log and continue to next phase
                self.completed_phases.append(agent_name)
                self._save_checkpoint(agent_name)
                phase_index += 1

            else:
                # Unknown signal, treat as done
                self.completed_phases.append(agent_name)
                self._save_checkpoint(agent_name)
                phase_index += 1

        # Clean up API client sessions
        cleanup_clients()

        # V3.2: Delete checkpoint on successful completion
        self._delete_checkpoint()

        # V3: Aggregate and log total cost
        total_cost = 0.0
        total_tokens = 0
        for result in self.state.agent_results:
            if result.metadata and 'cost' in result.metadata:
                cost_data = result.metadata['cost']
                total_cost += cost_data.get('total_cost_usd', 0)
                total_tokens += cost_data.get('total_tokens', 0)

        self.state.run_metadata['total_cost_usd'] = round(total_cost, 4)
        self.state.run_metadata['total_tokens'] = total_tokens
        logger.info("Total run cost: $%.4f (%s tokens)", total_cost, total_tokens)

        # V3: Record quality metrics for regression tracking
        tracker = get_regression_tracker()
        final_draft = self.state.get_final_draft()
        if final_draft:
            try:
                final_score = score_draft(final_draft)
                tracker.record(
                    run_id=self.state.run_id,
                    topic=self.state.topic,
                    score=final_score,
                    stage='final'
                )
                # Add cost to the quality record
                self.state.run_metadata['final_quality_score'] = final_score['overall_score']
                self.state.run_metadata['quality_gate_passed'] = final_score['passes_gate']
                logger.info("Final quality: %.1f%", final_score['overall_score'])
            except Exception as e:
                logger.warning("Failed to record quality metrics: %s", e)

        return final_draft
