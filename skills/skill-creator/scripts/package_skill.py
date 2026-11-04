#!/usr/bin/env python3
"""
Skill Packager - Creates a distributable .skill file of a skill folder

Usage:
    python utils/package_skill.py <path/to/skill-folder> [output-directory]

Example:
    python utils/package_skill.py skills/public/my-skill
    python utils/package_skill.py skills/public/my-skill ./dist
"""

import fnmatch
import sys
import zipfile
from pathlib import Path
from scripts.quick_validate import validate_skill
import argparse
import logging
from tqdm import tqdm

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class SkillPackagerConfig:
    """Configuration class for skill packaging settings."""
    
    # Patterns to exclude when packaging skills.
    EXCLUDE_DIRS = {"__pycache__", "node_modules"}
    EXCLUDE_GLOBS = {"*.pyc"}
    EXCLUDE_FILES = {".DS_Store"}
    # Directories excluded only at the skill root (not when nested deeper).
    ROOT_EXCLUDE_DIRS = {"evals"}


class SkillPackagerError(Exception):
    """Base exception for skill packager errors."""
    pass


class SkillValidationError(SkillPackagerError):
    """Exception raised when skill validation fails."""
    pass


class SkillPackagingError(SkillPackagerError):
    """Exception raised when skill packaging fails."""
    pass


class ExclusionManager:
    """Manages exclusion patterns for skill packaging."""
    
    def __init__(self, config=None):
        """Initialize with optional configuration."""
        self.config = config or SkillPackagerConfig()
    
    def should_exclude(self, rel_path: Path) -> bool:
        """Check if a path should be excluded from packaging."""
        parts = rel_path.parts
        if any(part in self.config.EXCLUDE_DIRS for part in parts):
            return True
        # rel_path is relative to skill_path.parent, so parts[0] is the skill
        # folder name and parts[1] (if present) is the first subdir.
        if len(parts) > 1 and parts[1] in self.config.ROOT_EXCLUDE_DIRS:
            return True
        name = rel_path.name
        if name in self.config.EXCLUDE_FILES:
            return True
        return any(fnmatch.fnmatch(name, pat) for pat in self.config.EXCLUDE_GLOBS)


def package_skill(skill_path, output_dir=None, show_progress=True):
    """
    Package a skill folder into a .skill file.

    Args:
        skill_path: Path to the skill folder
        output_dir: Optional output directory for the .skill file (defaults to current directory)
        show_progress: Whether to show a progress bar

    Returns:
        Path to the created .skill file, or None if error
    """
    skill_path = Path(skill_path).resolve()
    exclusion_manager = ExclusionManager()

    # Validate skill folder exists
    if not skill_path.exists():
        error_msg = f"Skill folder not found: {skill_path}"
        logger.error(error_msg)
        raise SkillPackagingError(error_msg)

    if not skill_path.is_dir():
        error_msg = f"Path is not a directory: {skill_path}"
        logger.error(error_msg)
        raise SkillPackagingError(error_msg)

    # Validate SKILL.md exists
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        error_msg = f"SKILL.md not found in {skill_path}"
        logger.error(error_msg)
        raise SkillPackagingError(error_msg)

    # Run validation before packaging
    logger.info("Validating skill...")
    valid, message = validate_skill(skill_path)
    if not valid:
        error_msg = f"Validation failed: {message}"
        logger.error(error_msg)
        logger.error("Please fix the validation errors before packaging.")
        raise SkillValidationError(error_msg)
    logger.info(f"{message}\n")

    # Determine output location
    skill_name = skill_path.name
    if output_dir:
        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path.cwd()

    skill_filename = output_path / f"{skill_name}.skill"

    # Create the .skill file (zip format)
    try:
        files_to_package = []
        for file_path in skill_path.rglob('*'):
            if file_path.is_file():
                arcname = file_path.relative_to(skill_path.parent)
                if not exclusion_manager.should_exclude(arcname):
                    files_to_package.append((file_path, arcname))

        with zipfile.ZipFile(skill_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            if show_progress:
                progress_bar = tqdm(files_to_package, desc="Packaging files")
            else:
                progress_bar = files_to_package
            
            for file_path, arcname in progress_bar:
                zipf.write(file_path, arcname)
                if not show_progress:
                    logger.info(f"Added: {arcname}")

        logger.info(f"\nSuccessfully packaged skill to: {skill_filename}")
        return skill_filename

    except Exception as e:
        error_msg = f"Error creating .skill file: {e}"
        logger.error(error_msg)
        raise SkillPackagingError(error_msg)


def main():
    parser = argparse.ArgumentParser(
        description="Package a skill folder into a distributable .skill file"
    )
    parser.add_argument(
        "skill_path",
        help="Path to the skill folder to package"
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        help="Optional output directory for the .skill file (defaults to current directory)"
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="Disable progress bar display"
    )
    
    args = parser.parse_args()

    logger.info(f"Packaging skill: {args.skill_path}")
    if args.output_dir:
        logger.info(f"Output directory: {args.output_dir}")
    logger.info("")

    try:
        result = package_skill(args.skill_path, args.output_dir, not args.no_progress)
        if result:
            sys.exit(0)
        else:
            sys.exit(1)
    except SkillPackagerError as e:
        logger.error(f"Error: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()