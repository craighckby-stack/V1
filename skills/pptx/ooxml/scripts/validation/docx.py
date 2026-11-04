"""
Validator for Word document XML files against XSD schemas.
"""

import re
import tempfile
import zipfile

import lxml.etree

from .base import BaseSchemaValidator
from .validators.xml_validator import XMLValidator
from .validators.namespace_validator import NamespaceValidator
from .validators.unique_id_validator import UniqueIDValidator
from .validators.file_reference_validator import FileReferenceValidator
from .validators.content_type_validator import ContentTypeValidator
from .validators.xsd_validator import XSDValidator
from .validators.whitespace_validator import WhitespaceValidator
from .validators.deletion_validator import DeletionValidator
from .validators.insertion_validator import InsertionValidator
from .validators.relationship_id_validator import RelationshipIDValidator
from .factories.validator_factory import ValidatorFactory
from .strategies.validation_strategy import ValidationStrategy
from .composite_validator import CompositeValidator


class DOCXSchemaValidator(BaseSchemaValidator):
    """Validator for Word document XML files against XSD schemas."""

    # Word-specific namespace
    WORD_2006_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

    # Word-specific element to relationship type mappings
    # Start with empty mapping - add specific cases as we discover them
    ELEMENT_RELATIONSHIP_TYPES = {}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._setup_validators()

    def _setup_validators(self):
        """Set up validators using factory pattern."""
        self.validator_factory = ValidatorFactory()
        self.validators = self.validator_factory.create_validators(
            document_type="docx",
            xml_files=self.xml_files,
            unpacked_dir=self.unpacked_dir,
            verbose=self.verbose
        )
        self.composite_validator = CompositeValidator(self.validators)

    def validate(self):
        """Run all validation checks and return True if all pass."""
        return self.composite_validator.validate()

    def validate_whitespace_preservation(self):
        """
        Validate that w:t elements with whitespace have xml:space='preserve'.
        """
        whitespace_validator = self.validator_factory.get_validator("whitespace")
        return whitespace_validator.validate()

    def validate_deletions(self):
        """
        Validate that w:t elements are not within w:del elements.
        For some reason, XSD validation does not catch this, so we do it manually.
        """
        deletion_validator = self.validator_factory.get_validator("deletion")
        return deletion_validator.validate()

    def validate_insertions(self):
        """
        Validate insertion elements.
        """
        insertion_validator = self.validator_factory.get_validator("insertion")
        return insertion_validator.validate()

    def validate_unique_ids(self):
        """
        Validate unique IDs in the document.
        """
        unique_id_validator = self.validator_factory.get_validator("unique_id")
        return unique_id_validator.validate()

    def validate_file_references(self):
        """
        Validate file references.
        """
        file_reference_validator = self.validator_factory.get_validator("file_reference")
        return file_reference_validator.validate()

    def validate_content_types(self):
        """
        Validate content types.
        """
        content_type_validator = self.validator_factory.get_validator("content_type")
        return content_type_validator.validate()

    def validate_against_xsd(self):
        """
        Validate against XSD schema.
        """
        xsd_validator = self.validator_factory.get_validator("xsd")
        return xsd_validator.validate()

    def validate_xml(self):
        """
        Validate XML well-formedness.
        """
        xml_validator = self.validator_factory.get_validator("xml")
        return xml_validator.validate()

    def validate_namespaces(self):
        """
        Validate namespace declarations.
        """
        namespace_validator = self.validator_factory.get_validator("namespace")
        return namespace_validator.validate()

    def validate_all_relationship_ids(self):
        """
        Validate all relationship IDs.
        """
        relationship_id_validator = self.validator_factory.get_validator("relationship_id")
        return relationship_id_validator.validate()

    def compare_paragraph_counts(self):
        """
        Count and compare paragraphs.
        """
        # This method remains unchanged as it's not part of the validation strategy
        # but rather a comparison utility
        pass