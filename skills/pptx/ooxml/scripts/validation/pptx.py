"""
Validator for PowerPoint presentation XML files against XSD schemas.
"""

import re
from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Set, Type

import lxml.etree

from .base import BaseSchemaValidator


class ValidationError:
    """Represents a validation error with detailed information."""
    
    def __init__(self, file_path: str, message: str, line_number: Optional[int] = None):
        self.file_path = file_path
        self.message = message
        self.line_number = line_number
    
    def __str__(self):
        result = f"  {self.file_path}: {self.message}"
        if self.line_number:
            result += f" (Line {self.line_number})"
        return result


class ValidationRule(ABC):
    """Abstract base class for validation rules."""
    
    def __init__(self, validator: 'PPTXSchemaValidator'):
        self.validator = validator
    
    @abstractmethod
    def validate(self) -> List[ValidationError]:
        """Execute the validation rule and return any errors found."""
        pass


class UUIDValidationRule(ValidationRule):
    """Validates that ID attributes that look like UUIDs contain only hex values."""
    
    def validate(self) -> List[ValidationError]:
        errors = []
        # UUID pattern: 8-4-4-4-12 hex digits with optional braces/hyphens
        uuid_pattern = re.compile(
            r"^[\{\(]?[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}[\}\)]?$"
        )

        for xml_file in self.validator.xml_files:
            try:
                root = lxml.etree.parse(str(xml_file)).getroot()

                # Check all elements for ID attributes
                for elem in root.iter():
                    for attr, value in elem.attrib.items():
                        # Check if this is an ID attribute
                        attr_name = attr.split("}")[-1].lower()
                        if attr_name == "id" or attr_name.endswith("id"):
                            # Check if value looks like a UUID (has the right length and pattern structure)
                            if self._looks_like_uuid(value):
                                # Validate that it contains only hex characters in the right positions
                                if not uuid_pattern.match(value):
                                    errors.append(
                                        ValidationError(
                                            file_path=str(xml_file.relative_to(self.validator.unpacked_dir)),
                                            message=f"ID '{value}' appears to be a UUID but contains invalid hex characters",
                                            line_number=elem.sourceline
                                        )
                                    )

            except (lxml.etree.XMLSyntaxError, Exception) as e:
                errors.append(
                    ValidationError(
                        file_path=str(xml_file.relative_to(self.validator.unpacked_dir)),
                        message=f"Error: {e}"
                    )
                )

        return errors
    
    def _looks_like_uuid(self, value):
        """Check if a value has the general structure of a UUID."""
        # Remove common UUID delimiters
        clean_value = value.strip("{}()").replace("-", "")
        # Check if it's 32 hex-like characters (could include invalid hex chars)
        return len(clean_value) == 32 and all(c.isalnum() for c in clean_value)


class SlideLayoutValidationRule(ValidationRule):
    """Validates that sldLayoutId elements in slide masters reference valid slide layouts."""
    
    def validate(self) -> List[ValidationError]:
        errors = []

        # Find all slide master files
        slide_masters = list(self.validator.unpacked_dir.glob("ppt/slideMasters/*.xml"))

        if not slide_masters:
            return []

        for slide_master in slide_masters:
            try:
                # Parse the slide master file
                root = lxml.etree.parse(str(slide_master)).getroot()

                # Find the corresponding _rels file for this slide master
                rels_file = slide_master.parent / "_rels" / f"{slide_master.name}.rels"

                if not rels_file.exists():
                    errors.append(
                        ValidationError(
                            file_path=str(slide_master.relative_to(self.validator.unpacked_dir)),
                            message=f"Missing relationships file: {rels_file.relative_to(self.validator.unpacked_dir)}"
                        )
                    )
                    continue

                # Parse the relationships file
                rels_root = lxml.etree.parse(str(rels_file)).getroot()

                # Build a set of valid relationship IDs that point to slide layouts
                valid_layout_rids = set()
                for rel in rels_root.findall(
                    f"{{{self.validator.PRESENTATIONML_NAMESPACE}}}Relationship"
                ):
                    rel_type = rel.get("Type", "")
                    if "slideLayout" in rel_type:
                        valid_layout_rids.add(rel.get("Id", ""))

                # Find all sldLayoutId elements in the slide master
                for sld_layout_id in root.findall(
                    f".//{{{self.validator.PRESENTATIONML_NAMESPACE}}}sldLayoutId"
                ):
                    layout_id = sld_layout_id.get("id", "")
                    if layout_id and layout_id not in valid_layout_rids:
                        errors.append(
                            ValidationError(
                                file_path=str(slide_master.relative_to(self.validator.unpacked_dir)),
                                message=f"Invalid slide layout ID reference: {layout_id}",
                                line_number=sld_layout_id.sourceline
                            )
                        )

            except (lxml.etree.XMLSyntaxError, Exception) as e:
                errors.append(
                    ValidationError(
                        file_path=str(slide_master.relative_to(self.validator.unpacked_dir)),
                        message=f"Error: {e}"
                    )
                )

        return errors


class DuplicateSlideLayoutValidationRule(ValidationRule):
    """Validates that there are no duplicate slide layout references."""
    
    def validate(self) -> List[ValidationError]:
        errors = []

        # Track all slide layout references
        layout_references = {}

        # Find all slide files
        slides = list(self.validator.unpacked_dir.glob("ppt/slides/*.xml"))

        for slide in slides:
            try:
                root = lxml.etree.parse(str(slide)).getroot()

                # Find the slideLayoutId element
                slide_layout_id = root.find(
                    f".//{{{self.validator.PRESENTATIONML_NAMESPACE}}}slideLayoutId"
                )

                if slide_layout_id is not None:
                    layout_id = slide_layout_id.get("id", "")
                    if layout_id:
                        if layout_id not in layout_references:
                            layout_references[layout_id] = []
                        layout_references[layout_id].append(
                            str(slide.relative_to(self.validator.unpacked_dir))
                        )

            except (lxml.etree.XMLSyntaxError, Exception) as e:
                errors.append(
                    ValidationError(
                        file_path=str(slide.relative_to(self.validator.unpacked_dir)),
                        message=f"Error: {e}"
                    )
                )

        # Check for duplicates
        for layout_id, slide_files in layout_references.items():
            if len(slide_files) > 1:
                errors.append(
                    ValidationError(
                        file_path=", ".join(slide_files),
                        message=f"Duplicate slide layout ID reference: {layout_id} found in {len(slide_files)} slides"
                    )
                )

        return errors


class NotesSlideReferenceValidationRule(ValidationRule):
    """Validates that notes slide references are properly configured."""
    
    def validate(self) -> List[ValidationError]:
        errors = []

        # Find all slide files
        slides = list(self.validator.unpacked_dir.glob("ppt/slides/*.xml"))

        for slide in slides:
            try:
                root = lxml.etree.parse(str(slide)).getroot()

                # Find the notesSlide element
                notes_slide = root.find(
                    f".//{{{self.validator.PRESENTATIONML_NAMESPACE}}}notesSlide"
                )

                if notes_slide is not None:
                    # Check if there's a corresponding notes slide file
                    notes_slide_id = notes_slide.get("id", "")
                    if notes_slide_id:
                        # Construct the expected notes slide file path
                        notes_file = self.validator.unpacked_dir / "ppt/notesSlides" / f"notesSlide{notes_slide_id}.xml"
                        if not notes_file.exists():
                            errors.append(
                                ValidationError(
                                    file_path=str(slide.relative_to(self.validator.unpacked_dir)),
                                    message=f"Referenced notes slide file does not exist: {notes_file.relative_to(self.validator.unpacked_dir)}",
                                    line_number=notes_slide.sourceline
                                )
                            )

            except (lxml.etree.XMLSyntaxError, Exception) as e:
                errors.append(
                    ValidationError(
                        file_path=str(slide.relative_to(self.validator.unpacked_dir)),
                        message=f"Error: {e}"
                    )
                )

        return errors


class ValidationRuleFactory:
    """Factory for creating validation rules."""
    
    _rule_classes: Dict[str, Type[ValidationRule]] = {
        "uuid": UUIDValidationRule,
        "slide_layout": SlideLayoutValidationRule,
        "duplicate_slide_layout": DuplicateSlideLayoutValidationRule,
        "notes_slide_reference": NotesSlideReferenceValidationRule,
    }
    
    @classmethod
    def create_rule(cls, rule_name: str, validator: 'PPTXSchemaValidator') -> Optional[ValidationRule]:
        """Create a validation rule instance by name."""
        rule_class = cls._rule_classes.get(rule_name)
        if rule_class:
            return rule_class(validator)
        return None
    
    @classmethod
    def register_rule(cls, rule_name: str, rule_class: Type[ValidationRule]):
        """Register a new validation rule class."""
        cls._rule_classes[rule_name] = rule_class


class ValidationPipeline:
    """Manages the execution of multiple validation rules."""
    
    def __init__(self, validator: 'PPTXSchemaValidator'):
        self.validator = validator
        self.rules: List[ValidationRule] = []
    
    def add_rule(self, rule: ValidationRule):
        """Add a validation rule to the pipeline."""
        self.rules.append(rule)
    
    def execute(self) -> List[ValidationError]:
        """Execute all validation rules and return combined errors."""
        all_errors = []
        for rule in self.rules:
            errors = rule.validate()
            all_errors.extend(errors)
        return all_errors


class PPTXSchemaValidator(BaseSchemaValidator):
    """Validator for PowerPoint presentation XML files against XSD schemas."""

    # PowerPoint presentation namespace
    PRESENTATIONML_NAMESPACE = (
        "http://schemas.openxmlformats.org/presentationml/2006/main"
    )

    # PowerPoint-specific element to relationship type mappings
    ELEMENT_RELATIONSHIP_TYPES = {
        "sldid": "slide",
        "sldmasterid": "slidemaster",
        "notesmasterid": "notesmaster",
        "sldlayoutid": "slidelayout",
        "themeid": "theme",
        "tablestyleid": "tablestyles",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.validation_pipeline = ValidationPipeline(self)
        self._setup_default_rules()

    def _setup_default_rules(self):
        """Set up the default validation rules."""
        self.validation_pipeline.add_rule(ValidationRuleFactory.create_rule("uuid", self))
        self.validation_pipeline.add_rule(ValidationRuleFactory.create_rule("slide_layout", self))
        self.validation_pipeline.add_rule(ValidationRuleFactory.create_rule("duplicate_slide_layout", self))
        self.validation_pipeline.add_rule(ValidationRuleFactory.create_rule("notes_slide_reference", self))

    def validate(self):
        """Run all validation checks and return True if all pass."""
        # Test 0: XML well-formedness
        if not self.validate_xml():
            return False

        # Test 1: Namespace declarations
        all_valid = True
        if not self.validate_namespaces():
            all_valid = False

        # Test 2: Unique IDs
        if not self.validate_unique_ids():
            all_valid = False

        # Test 3: Relationship and file reference validation
        if not self.validate_file_references():
            all_valid = False

        # Test 4: Content type declarations
        if not self.validate_content_types():
            all_valid = False

        # Test 5: XSD schema validation
        if not self.validate_against_xsd():
            all_valid = False

        # Test 6: Relationship ID reference validation
        if not self.validate_all_relationship_ids():
            all_valid = False

        # Execute custom validation rules
        validation_errors = self.validation_pipeline.execute()
        if validation_errors:
            print(f"FAILED - Found {len(validation_errors)} validation errors:")
            for error in validation_errors:
                print(error)
            all_valid = False

        return all_valid

    def validate_uuid_ids(self):
        """Validate that ID attributes that look like UUIDs contain only hex values."""
        rule = UUIDValidationRule(self)
        errors = rule.validate()
        
        if errors:
            print(f"FAILED - Found {len(errors)} UUID ID validation errors:")
            for error in errors:
                print(error)
            return False
        else:
            if self.verbose:
                print("PASSED - All UUID-like IDs contain valid hex values")
            return True

    def validate_slide_layout_ids(self):
        """Validate that sldLayoutId elements in slide masters reference valid slide layouts."""
        rule = SlideLayoutValidationRule(self)
        errors = rule.validate()
        
        if errors:
            print(f"FAILED - Found {len(errors)} slide layout ID validation errors:")
            for error in errors:
                print(error)
            return False
        else:
            if self.verbose:
                print("PASSED - All slide layout ID references are valid")
            return True

    def validate_no_duplicate_slide_layouts(self):
        """Validates that there are no duplicate slide layout references."""
        rule = DuplicateSlideLayoutValidationRule(self)
        errors = rule.validate()
        
        if errors:
            print(f"FAILED - Found {len(errors)} duplicate slide layout validation errors:")
            for error in errors:
                print(error)
            return False
        else:
            if self.verbose:
                print("PASSED - No duplicate slide layout references found")
            return True

    def validate_notes_slide_references(self):
        """Validates that notes slide references are properly configured."""
        rule = NotesSlideReferenceValidationRule(self)
        errors = rule.validate()
        
        if errors:
            print(f"FAILED - Found {len(errors)} notes slide reference validation errors:")
            for error in errors:
                print(error)
            return False
        else:
            if self.verbose:
                print("PASSED - All notes slide references are valid")
            return True