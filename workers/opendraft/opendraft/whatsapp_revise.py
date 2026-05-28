#!/usr/bin/env python3
"""WhatsApp revision wrapper for OpenDraft.

Replaces the bash wrapper with a more robust Python implementation.
"""

import os
import sys
import json
import subprocess
import logging
import time
from pathlib import Path
from typing import Optional

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)

# Configuration
LOG_FILE = Path("/tmp/opendraft-revise.log")
LOCK_FILE = Path("/tmp/opendraft-revise.lock")
USER_MAP_FILE = Path("/tmp/opendraft-users.json")
TIMEOUT_SECONDS = 180

# File handler for logging
file_handler = logging.FileHandler(LOG_FILE)
file_handler.setFormatter(logging.Formatter('[%(asctime)s] %(message)s', datefmt='%H:%M:%S'))
logger.addHandler(file_handler)


def get_env_config():
    """Get configuration from environment."""
    return {
        'api_key': os.environ.get('GOOGLE_API_KEY', ''),
        'chat_id': os.environ.get('OPENCLAW_CHAT', '120363408614255618@g.us'),
        'user': os.environ.get('OPENCLAW_USER', ''),
    }


def send_whatsapp(message: str, media: Optional[Path] = None) -> bool:
    """Send a WhatsApp message via openclaw."""
    config = get_env_config()
    cmd = [
        'openclaw', 'message', 'send',
        '--channel', 'whatsapp',
        '--target', config['chat_id'],
        '--message', message,
    ]
    if media and media.exists():
        cmd.extend(['--media', str(media)])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        success = 'Sent' in result.stdout
        logger.info("WhatsApp: %s", 'sent' if success else 'failed')
        return success
    except Exception as e:
        logger.error("WhatsApp error: %s", e)
        return False


def sanitize_input(text: str) -> str:
    """Remove dangerous shell characters from input."""
    dangerous = ['`', '$(', '${', ';', '|', '&', '<', '>', '\x00']
    result = text
    for char in dangerous:
        result = result.replace(char, '')
    return result.strip()


def load_user_map() -> dict:
    """Load user to folder mapping."""
    if USER_MAP_FILE.exists():
        try:
            return json.loads(USER_MAP_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_user_map(user_map: dict):
    """Save user to folder mapping."""
    USER_MAP_FILE.write_text(json.dumps(user_map))


def get_user_folder(user: str) -> Optional[Path]:
    """Get the folder associated with a user."""
    user_map = load_user_map()
    folder = user_map.get(user)
    if folder and Path(folder).exists():
        return Path(folder)
    return None


def save_user_folder(user: str, folder: Path):
    """Save user to folder mapping."""
    if user:
        user_map = load_user_map()
        user_map[user] = str(folder)
        save_user_map(user_map)
        logger.info("Saved mapping: %s -> %s", user, folder)


def find_opendraft_folder() -> Optional[Path]:
    """Find most recent opendraft output folder with drafts."""
    tmp = Path('/tmp')
    folders = []

    for pattern in ['opendraft_20*']:
        folders.extend(tmp.glob(pattern))
        for subdir in tmp.iterdir():
            if subdir.is_dir():
                folders.extend(subdir.glob(pattern))

    # Sort by modification time
    folders = sorted(folders, key=lambda p: p.stat().st_mtime, reverse=True)

    for folder in folders:
        exports = folder / 'exports'
        if exports.exists() and list(exports.glob('*.md')):
            return folder

    return None


def parse_version(instructions: str) -> tuple[Optional[str], str]:
    """Parse version prefix from instructions.

    Returns (version, remaining_instructions).
    Example: "v3: make shorter" -> ("v3", "make shorter")
    """
    import re
    match = re.match(r'^(v\d+):\s*(.*)$', instructions, re.IGNORECASE)
    if match:
        return match.group(1).lower(), match.group(2)
    return None, instructions


def parse_section(instructions: str) -> tuple[Optional[int], str]:
    """Parse --section N from instructions.

    Returns (section_num, remaining_instructions).
    Example: "fix intro --section 1" -> (1, "fix intro")
    """
    import re
    match = re.search(r'--section\s+(\d+)', instructions, re.IGNORECASE)
    if match:
        section = int(match.group(1))
        remaining = re.sub(r'\s*--section\s+\d+\s*', ' ', instructions).strip()
        return section, remaining
    return None, instructions


def is_rollback_command(text: str) -> Optional[str]:
    """Check if text is a rollback command.

    Returns version to rollback to, or None.
    Example: "rollback v2" -> "v2"
    """
    import re
    match = re.match(r'^rollback\s+(v\d+)$', text.strip(), re.IGNORECASE)
    if match:
        return match.group(1).lower()
    return None


def find_version_file(folder: Path, version: str) -> Optional[Path]:
    """Find a specific version file in the folder."""
    exports = folder / 'exports'
    for md_file in exports.glob(f'*_{version}.md'):
        return md_file
    for md_file in folder.glob(f'*_{version}.md'):
        return md_file
    return None


def round_words(count: int) -> str:
    """Round word count for display."""
    if count < 100:
        return f"~{count}"
    return f"~{(count // 100) * 100}"


def acquire_lock() -> bool:
    """Acquire exclusive lock for revision."""
    try:
        if LOCK_FILE.exists():
            lock_age = time.time() - LOCK_FILE.stat().st_mtime
            if lock_age < 300:  # 5 minutes
                logger.error("Another revision in progress (age: %.0fs)", lock_age)
                return False
            logger.info("Removing stale lock")
            LOCK_FILE.unlink()

        LOCK_FILE.write_text(str(os.getpid()))
        return True
    except Exception as e:
        logger.error("Lock error: %s", e)
        return False


def release_lock():
    """Release the lock file."""
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def run_revision(target: Path, instructions: str, section: int = None) -> dict:
    """Run opendraft revise and capture output."""
    cmd = ['opendraft', 'revise', str(target), instructions, '-y']

    if section:
        cmd.extend(['--section', str(section)])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            env={**os.environ, 'GOOGLE_API_KEY': get_env_config()['api_key']}
        )

        output = result.stdout + result.stderr

        # Parse quality line
        import re
        quality_match = re.search(r'Quality: ([\d.]+)% → ([\d.]+)% \(([+-][\d.]+)%\)', output)
        if quality_match:
            quality = {
                'before': float(quality_match.group(1)),
                'after': float(quality_match.group(2)),
                'delta': float(quality_match.group(3)),
            }
        else:
            quality = None

        # Parse component changes
        improvements = re.findall(r'Improved: (\w+) \(\+[\d.]+%\)', output)
        regressions = re.findall(r'Regressed: (\w+) \(-[\d.]+%\)', output)

        # Parse word count
        words_match = re.search(r'Words: ([\d,]+)', output)
        words = int(words_match.group(1).replace(',', '')) if words_match else None

        return {
            'success': result.returncode == 0,
            'output': output,
            'quality': quality,
            'improvements': improvements,
            'regressions': regressions,
            'words': words,
            'returncode': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'timeout', 'output': ''}
    except Exception as e:
        return {'success': False, 'error': str(e), 'output': ''}


def handle_rollback(version: str) -> int:
    """Handle rollback command."""
    logger.info("=== Rollback to %s ===", version)

    config = get_env_config()
    user = config['user']

    # Find folder
    folder = get_user_folder(user) if user else None
    if not folder:
        folder = find_opendraft_folder()

    if not folder:
        send_whatsapp("[opendraft] No recent paper found. Generate one first.")
        return 1

    # Find the version file
    version_file = find_version_file(folder, version)
    if not version_file:
        exports = folder / 'exports'
        available = [f.stem.split('_')[-1] for f in exports.glob('*_v*.md')]
        send_whatsapp(f"[opendraft] Version {version} not found.\nAvailable: {', '.join(sorted(available))}")
        return 1

    # Run rollback via CLI
    cmd = ['opendraft', 'rollback', str(folder), version]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if result.returncode != 0:
            send_whatsapp(f"[opendraft] Rollback failed: {result.stderr[:100]}")
            return 1

        # Find the new version PDF
        pdf = find_latest_pdf(folder)
        if pdf:
            workspace = Path.home() / '.openclaw' / 'workspace'
            workspace.mkdir(parents=True, exist_ok=True)
            dest_pdf = workspace / pdf.name
            dest_pdf.write_bytes(pdf.read_bytes())

            new_version = pdf.stem.split('_')[-1]
            send_whatsapp(f"[opendraft] Rolled back to {version} → created {new_version}", dest_pdf)
            logger.info("Rollback complete: %s", pdf)
        else:
            send_whatsapp(f"[opendraft] Rolled back to {version}")

        return 0

    except subprocess.TimeoutExpired:
        send_whatsapp("[opendraft] Rollback timed out.")
        return 1
    except Exception as e:
        send_whatsapp(f"[opendraft] Rollback error: {str(e)[:100]}")
        return 1


def find_latest_pdf(folder: Path) -> Optional[Path]:
    """Find the most recently created versioned PDF."""
    exports = folder / 'exports'
    pdfs = list(exports.glob('*_v*.pdf'))
    if not pdfs:
        pdfs = list(folder.glob('*_v*.pdf'))
    if pdfs:
        return max(pdfs, key=lambda p: p.stat().st_mtime)
    return None


def main():
    """Main entry point for WhatsApp revision."""
    logger.info("=== Starting revision ===")

    config = get_env_config()
    user = config['user']
    logger.info("User: %s", user or 'anonymous')

    # Parse arguments
    if len(sys.argv) < 2:
        send_whatsapp("[opendraft] Please provide revision instructions.\nExample: revise: make it shorter")
        return 1

    raw_instructions = ' '.join(sys.argv[1:])
    instructions = sanitize_input(raw_instructions)

    # Check for rollback command
    rollback_version = is_rollback_command(instructions)
    if rollback_version:
        return handle_rollback(rollback_version)

    # Check for --docx flag
    send_docx = '--docx' in instructions.lower()
    instructions = instructions.replace('--docx', '').replace('--DOCX', '').strip()

    # Parse section flag
    section, instructions = parse_section(instructions)
    if section:
        logger.info("Target section: %s", section)

    # Parse version prefix
    target_version, instructions = parse_version(instructions)
    if target_version:
        logger.info("Target version: %s", target_version)

    logger.info("Instructions: %s", instructions)

    if not instructions:
        send_whatsapp("[opendraft] Please provide revision instructions.")
        return 1

    # Acquire lock
    if not acquire_lock():
        send_whatsapp("[opendraft] Another revision in progress. Please wait ~3 minutes.")
        return 1

    try:
        # Find folder
        folder = None
        if user:
            folder = get_user_folder(user)
            if folder:
                logger.info("Using tracked folder: %s", folder)

        if not folder:
            folder = find_opendraft_folder()

        if not folder:
            logger.error("No folder found")
            send_whatsapp("[opendraft] No recent paper found. Generate one first.")
            return 1

        # Handle version selection
        if target_version:
            version_file = find_version_file(folder, target_version)
            if not version_file:
                available = [f.stem.split('_')[-1] for f in (folder / 'exports').glob('*_v*.md')]
                send_whatsapp(f"[opendraft] Version {target_version} not found.\nAvailable: {', '.join(sorted(available))}")
                return 1
            target = version_file
            logger.info("Revising from: %s", version_file)
        else:
            target = folder

        # Save user mapping
        if user:
            save_user_folder(user, folder)

        # Send acknowledgment
        version_note = f" (from {target_version})" if target_version else ""
        section_note = f" section {section}" if section else ""
        send_whatsapp(f"[opendraft] Revising{section_note}{version_note}... (~2-3 min)\nSource: {folder.name}\nInstructions: {instructions[:80]}...")

        # Run revision
        logger.info("Target: %s%s", target, f" section {section}" if section else "")
        result = run_revision(target, instructions, section=section)

        if not result['success']:
            if result.get('error') == 'timeout':
                send_whatsapp("[opendraft] Revision timed out. Try simpler instructions.")
            else:
                error = result.get('error', 'Unknown error')[:100]
                send_whatsapp(f"[opendraft] Revision failed: {error}")
            return 1

        # Find output PDF
        pdf = find_latest_pdf(folder)
        if not pdf:
            send_whatsapp("[opendraft] Revision completed but PDF not found.")
            return 1

        # Copy to workspace
        workspace = Path.home() / '.openclaw' / 'workspace'
        workspace.mkdir(parents=True, exist_ok=True)
        dest_pdf = workspace / pdf.name
        dest_pdf.write_bytes(pdf.read_bytes())

        # Build message
        quality = result.get('quality')
        if quality:
            quality_line = f"Quality: {quality['before']:.1f}% → {quality['after']:.1f}% ({quality['delta']:+.1f}%)"
        else:
            quality_line = "Quality: updated"

        words = result.get('words', 0)
        words_display = round_words(words) if words else "~8000"

        version = pdf.stem.split('_')[-1]  # Extract v2, v3, etc.

        msg_lines = [
            "[opendraft] Revision complete!",
            quality_line,
            f"{words_display} words | {version}",
        ]

        # Add component changes
        if result.get('improvements'):
            msg_lines.append("↑ " + ", ".join(result['improvements']))
        if result.get('regressions'):
            msg_lines.append("↓ " + ", ".join(result['regressions']))

        if quality and quality['delta'] < -5:
            msg_lines.append("⚠️ Quality dropped - review changes")

        message = "\n".join(msg_lines)

        # Send PDF
        for attempt in range(3):
            if send_whatsapp(message, dest_pdf):
                logger.info("PDF delivered")
                break
            time.sleep(5)

        # Send DOCX if requested
        if send_docx:
            docx = pdf.with_suffix('.docx')
            if docx.exists():
                dest_docx = workspace / docx.name
                dest_docx.write_bytes(docx.read_bytes())
                time.sleep(2)
                send_whatsapp("[opendraft] Word document:", dest_docx)
                logger.info("DOCX delivered")

        logger.info("=== DONE: %s ===", pdf)
        return 0

    finally:
        release_lock()


if __name__ == '__main__':
    sys.exit(main())
