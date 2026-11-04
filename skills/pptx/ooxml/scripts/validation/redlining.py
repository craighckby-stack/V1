"""
Validator for tracked changes in Word documents.
"""

import subprocess
import tempfile
import zipfile
from pathlib import Path


class XmlParser:
    """Utility class for parsing XML files with Word namespaces."""
    
    def __init__(self):
        self.namespaces = {
            "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        }
    
    def parse_file(self, file_path):
        """Parse an XML file and return its root element."""
        import xml.etree.ElementTree as ET
        tree = ET.parse(file_path)
        return tree.getroot()
    
    def find_tracked_changes(self, root):
        """Find all tracked changes (del and ins elements) in the XML."""
        del_elements = root.findall(".//w:del", self.namespaces)
        ins_elements = root.findall(".//w:ins", self.namespaces)
        return del_elements, ins_elements
    
    def find_zai_changes(self, root):
        """Find all tracked changes authored by Z.AI."""
        del_elements, ins_elements = self.find_tracked_changes(root)
        
        zai_del_elements = [
            elem
            for elem in del_elements
            if elem.get(f"{{{self.namespaces['w']}}}author") == "Z.AI"
        ]
        zai_ins_elements = [
            elem
            for elem in ins_elements
            if elem.get(f"{{{self.namespaces['w']}}}author") == "Z.AI"
        ]
        
        return zai_del_elements, zai_ins_elements


class TrackedChanges:
    """Handler for Z.AI-specific change detection and removal."""
    
    def __init__(self, namespaces):
        self.namespaces = namespaces
    
    def remove_zai_tracked_changes(self, root):
        """Remove all tracked changes authored by Z.AI from the XML tree."""
        zai_del_elements, zai_ins_elements = self._find_zai_elements(root)
        
        # Remove Z.AI deletion elements
        for elem in zai_del_elements:
            parent = elem.getparent()
            if parent is not None:
                parent.remove(elem)
        
        # Remove Z.AI insertion elements
        for elem in zai_ins_elements:
            parent = elem.getparent()
            if parent is not None:
                parent.remove(elem)
    
    def _find_zai_elements(self, root):
        """Find all Z.AI-specific tracked changes in the XML."""
        del_elements = root.findall(".//w:del", self.namespaces)
        ins_elements = root.findall(".//w:ins", self.namespaces)
        
        zai_del_elements = [
            elem
            for elem in del_elements
            if elem.get(f"{{{self.namespaces['w']}}}author") == "Z.AI"
        ]
        zai_ins_elements = [
            elem
            for elem in ins_elements
            if elem.get(f"{{{self.namespaces['w']}}}author") == "Z.AI"
        ]
        
        return zai_del_elements, zai_ins_elements


class DocumentComparator:
    """Handles text extraction and comparison logic for Word documents."""
    
    def __init__(self, verbose=False):
        self.verbose = verbose
    
    def extract_text_content(self, root):
        """Extract text content from an XML document root."""
        text_parts = []
        for elem in root.iter():
            if elem.text:
                text_parts.append(elem.text)
        return "".join(text_parts)
    
    def compare_texts(self, original_text, modified_text):
        """Compare two texts and return True if they match, False otherwise."""
        if original_text == modified_text:
            return True
        
        # Generate detailed diff if texts don't match
        error_message = self._generate_detailed_diff(original_text, modified_text)
        print(error_message)
        return False
    
    def _generate_detailed_diff(self, original_text, modified_text):
        """Generate detailed word-level differences using git word diff."""
        error_parts = [
            "FAILED - Document text doesn't match after removing Z.AI's tracked changes",
            "",
            "Likely causes:",
            "  1. Modified text inside another author's <w:ins> or <w:del> tags",
            "  2. Made edits without proper tracked changes",
            "  3. Didn't nest <w:del> inside <w:ins> when deleting another's insertion",
            "",
            "For pre-redlined documents, use correct patterns:",
            "  - To reject another's INSERTION: Nest <w:del> inside their <w:ins>",
            "  - To restore another's DELETION: Add new <w:ins> AFTER their <w:del>",
            "",
        ]

        # Show git word diff
        git_diff = self._get_git_word_diff(original_text, modified_text)
        if git_diff:
            error_parts.extend(["Differences:", "============", git_diff])
        else:
            error_parts.append("Unable to generate word diff (git not available)")

        return "\n".join(error_parts)
    
    def _get_git_word_diff(self, original_text, modified_text):
        """Generate word diff using git with character-level precision."""
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)

                # Create two files
                original_file = temp_path / "original.txt"
                modified_file = temp_path / "modified.txt"

                original_file.write_text(original_text, encoding="utf-8")
                modified_file.write_text(modified_text, encoding="utf-8")

                # Try character-level diff first
                try:
                    result = subprocess.run(
                        ["git", "diff", "--word-diff", "--unified=0", "--no-index", 
                         str(original_file), str(modified_file)],
                        capture_output=True, text=True, check=True
                    )
                    return result.stdout
                except subprocess.CalledProcessError:
                    # Fall back to simpler diff if character-level fails
                    result = subprocess.run(
                        ["diff", str(original_file), str(modified_file)],
                        capture_output=True, text=True
                    )
                    return result.stdout
        except Exception:
            return None


class RedliningValidator:
    """Validator for tracked changes in Word documents."""

    def __init__(self, unpacked_dir, original_docx, verbose=False):
        self.unpacked_dir = Path(unpacked_dir)
        self.original_docx = Path(original_docx)
        self.verbose = verbose
        
        # Initialize helper components
        self.xml_parser = XmlParser()
        self.tracked_changes = TrackedChanges(self.xml_parser.namespaces)
        self.document_comparator = DocumentComparator(verbose)

    def validate(self):
        """Main validation method that returns True if valid, False otherwise."""
        # Verify unpacked directory exists and has correct structure
        modified_file = self.unpacked_dir / "word" / "document.xml"
        if not modified_file.exists():
            print(f"FAILED - Modified document.xml not found at {modified_file}")
            return False

        # First, check if there are any tracked changes by Z.AI to validate
        try:
            modified_root = self.xml_parser.parse_file(modified_file)
            zai_del_elements, zai_ins_elements = self.xml_parser.find_zai_changes(modified_root)

            # Redlining validation is only needed if tracked changes by Z.AI have been used.
            if not zai_del_elements and not zai_ins_elements:
                if self.verbose:
                    print("PASSED - No tracked changes by Z.AI found.")
                return True

        except Exception as e:
            if self.verbose:
                print(f"Warning - Error checking for Z.AI changes: {e}")
            # If we can't parse the XML, continue with full validation
            pass

        # Create temporary directory for unpacking original docx
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)

            # Unpack original docx
            try:
                with zipfile.ZipFile(self.original_docx, "r") as zip_ref:
                    zip_ref.extractall(temp_path)
            except Exception as e:
                print(f"FAILED - Error unpacking original docx: {e}")
                return False

            original_file = temp_path / "word" / "document.xml"
            if not original_file.exists():
                print(
                    f"FAILED - Original document.xml not found in {self.original_docx}"
                )
                return False

            # Parse both XML files using xml.etree.ElementTree for redlining validation
            try:
                original_root = self.xml_parser.parse_file(original_file)
                modified_root = self.xml_parser.parse_file(modified_file)
            except Exception as e:
                print(f"FAILED - Error parsing XML files: {e}")
                return False

            # Remove Z.AI's tracked changes from both documents
            self.tracked_changes.remove_zai_tracked_changes(original_root)
            self.tracked_changes.remove_zai_tracked_changes(modified_root)

            # Extract and compare text content
            modified_text = self.document_comparator.extract_text_content(modified_root)
            original_text = self.document_comparator.extract_text_content(original_root)

            if self.document_comparator.compare_texts(original_text, modified_text):
                if self.verbose:
                    print("PASSED - All changes by Z.AI are properly tracked")
                return True
            return False