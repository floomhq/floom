"""Format research results as APA tables and prose.

Converts natural language descriptions of statistical results into
APA-formatted markdown tables and prose paragraphs ready for academic papers.
"""

import re
from typing import Dict, List, Optional, Any


class ResultsFormatter:
    """Format statistical results as APA tables and prose."""

    # Regex patterns for extracting statistical values
    PATTERNS = {
        # Regression coefficients: b=0.34, B=0.52, beta=0.34
        "coefficient": re.compile(
            r"(?P<predictor>[\w\s]+?)\s*"
            r"(?:b|B|beta|β)\s*=\s*(?P<value>-?\d+\.?\d*)"
            r"(?:\s*,?\s*(?:p\s*[=<>]\s*\.?\d+|p\s*<\s*\.?\d+))?",
            re.IGNORECASE
        ),
        # P-values: p=.001, p<.05, p = 0.003 (capture the dot if present)
        "p_value": re.compile(
            r"p\s*([=<>])\s*(\.?\d+\.?\d*)",
            re.IGNORECASE
        ),
        # R-squared: R²=0.43, R-squared=0.43, R2=0.43, R-squared 0.43
        "r_squared": re.compile(
            r"(?:R[²2]|R-squared|r-squared)\s*[=:\s]\s*(\d+\.?\d*)",
            re.IGNORECASE
        ),
        # F-statistic: F=12.4, F(2,242)=12.4
        "f_stat": re.compile(
            r"F\s*(?:\(\s*\d+\s*,\s*\d+\s*\))?\s*[=:]\s*(\d+\.?\d*)",
            re.IGNORECASE
        ),
        # Sample size: n=245, N=245
        "sample_size": re.compile(
            r"[nN]\s*[=:]\s*(\d+)"
        ),
        # T-statistic: t=3.45, t(98)=3.45
        "t_stat": re.compile(
            r"t\s*(?:\(\s*\d+\s*\))?\s*[=:]\s*(-?\d+\.?\d*)",
            re.IGNORECASE
        ),
        # Degrees of freedom: df=98, df=2,242
        "df": re.compile(
            r"df\s*[=:]\s*(\d+(?:\s*,\s*\d+)?)",
            re.IGNORECASE
        ),
        # Correlation: r=.45, r = 0.45
        "correlation": re.compile(
            r"(?<![a-zA-Z])r\s*[=:]\s*(-?\.?\d+\.?\d*)",
            re.IGNORECASE
        ),
        # Means: M=4.2, mean=4.2, M=-2.5
        "mean": re.compile(
            r"(?:M|mean)\s*[=:]\s*(-?\d+\.?\d*)",
            re.IGNORECASE
        ),
        # Standard deviation: SD=1.1, sd=1.1
        "sd": re.compile(
            r"(?:SD|sd)\s*[=:]\s*(\d+\.?\d*)",
            re.IGNORECASE
        ),
        # Cohen's d: d=0.8, d = 0.8
        "cohens_d": re.compile(
            r"(?<![a-zA-Z])d\s*[=:]\s*(\d+\.?\d*)",
            re.IGNORECASE
        ),
        # Effect size: effect size=0.5
        "effect_size": re.compile(
            r"effect\s*size\s*[=:]\s*(\d+\.?\d*)",
            re.IGNORECASE
        ),
    }

    # Result type detection patterns
    TYPE_PATTERNS = {
        "regression": re.compile(
            r"\b(?:regression|b\s*=|beta|R[²2]|R-squared|predict)\b",
            re.IGNORECASE
        ),
        "ttest": re.compile(
            r"\b(?:t-test|t\s*=|t\s*\(\d+\)|paired|independent samples?)\b",
            re.IGNORECASE
        ),
        "correlation": re.compile(
            r"(?:\bcorrelat|(?<![a-zA-Z])r\s*=\s*[-.]?\d|\bPearson|\bSpearman)",
            re.IGNORECASE
        ),
        "descriptive": re.compile(
            r"\b(?:descriptive|M\s*=|mean\s*=|SD\s*=)\b",
            re.IGNORECASE
        ),
        "anova": re.compile(
            r"\b(?:ANOVA|F\s*\(\d+\s*,\s*\d+\)|between.groups?|within.subjects?)\b",
            re.IGNORECASE
        ),
    }

    def format(self, description: str, result_type: Optional[str] = None) -> str:
        """Format a natural language description of results into APA format.

        Args:
            description: Natural language description of statistical results
            result_type: Optional type hint (regression, ttest, anova, correlation, descriptive)

        Returns:
            Formatted markdown with APA table and prose paragraph
        """
        # Auto-detect result type if not provided
        if not result_type:
            result_type = self._detect_type(description)

        # Extract statistical values
        values = self._extract_values(description)

        # Generate table and prose based on type
        table = self._generate_table(result_type, values, description)
        prose = self._generate_prose(result_type, values, description)

        return f"{table}\n\n{prose}"

    def _detect_type(self, description: str) -> str:
        """Auto-detect the type of statistical result from description."""
        scores = {}
        for type_name, pattern in self.TYPE_PATTERNS.items():
            matches = pattern.findall(description)
            scores[type_name] = len(matches)

        if not any(scores.values()):
            return "descriptive"  # Default fallback

        return max(scores, key=scores.get)

    def _extract_values(self, description: str) -> Dict[str, Any]:
        """Extract all statistical values from the description."""
        values = {
            "coefficients": [],
            "p_values": [],
            "r_squared": None,
            "f_stat": None,
            "n": None,
            "t_stat": None,
            "df": None,
            "correlation": None,
            "means": [],
            "sds": [],
            "cohens_d": None,
            "effect_size": None,
        }

        # Extract coefficients with their predictors
        # Look for patterns like "salary b=0.34 p=.001" or "job satisfaction b=0.34"
        # Captures 1-2 words before b=, then removes leading stop words
        coef_pattern = re.compile(
            r"([a-zA-Z][a-zA-Z0-9_]*(?:\s+[a-zA-Z][a-zA-Z0-9_]*)?)\s+"
            r"(?:b|B|beta|β)\s*=\s*(-?\d+\.?\d*)\s*"
            r"(?:,?\s*p\s*([=<>])\s*(\.?\d+\.?\d*))?",
            re.IGNORECASE
        )
        stop_words = {'with', 'and', 'for', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'by', 'or'}

        for match in coef_pattern.finditer(description):
            predictor = match.group(1).strip()
            # Remove leading stop words (e.g., "with salary" -> "salary")
            words = predictor.split()
            while words and words[0].lower() in stop_words:
                words.pop(0)
            predictor = ' '.join(words) if words else predictor

            coef = {
                "predictor": predictor,
                "value": float(match.group(2)),
                "p_value": None,
                "p_operator": None,
            }
            if match.group(3) and match.group(4):
                coef["p_operator"] = match.group(3)
                p_val = match.group(4)
                # Handle p-values like ".001" or "0.001"
                if p_val.startswith("."):
                    coef["p_value"] = float("0" + p_val)
                else:
                    coef["p_value"] = float(p_val)
            values["coefficients"].append(coef)

        # Extract standalone p-values (only those not already captured with coefficients)
        for match in self.PATTERNS["p_value"].finditer(description):
            operator = match.group(1)
            p_val = match.group(2)
            # Handle p-values like ".001" or "0.001"
            if p_val.startswith("."):
                p_value = float("0" + p_val)
            else:
                p_value = float(p_val)
            # Skip if this p-value was already captured with a coefficient
            already_captured = any(
                coef.get("p_value") == p_value for coef in values["coefficients"]
            )
            if not already_captured:
                values["p_values"].append({"operator": operator, "value": p_value})

        # Extract R-squared
        match = self.PATTERNS["r_squared"].search(description)
        if match:
            values["r_squared"] = float(match.group(1))

        # Extract F-statistic
        match = self.PATTERNS["f_stat"].search(description)
        if match:
            values["f_stat"] = float(match.group(1))

        # Extract sample size
        match = self.PATTERNS["sample_size"].search(description)
        if match:
            values["n"] = int(match.group(1))

        # Extract t-statistic
        match = self.PATTERNS["t_stat"].search(description)
        if match:
            values["t_stat"] = float(match.group(1))

        # Extract degrees of freedom
        match = self.PATTERNS["df"].search(description)
        if match:
            values["df"] = match.group(1).replace(" ", "")

        # Extract correlation coefficient
        match = self.PATTERNS["correlation"].search(description)
        if match:
            r_val = match.group(1)
            values["correlation"] = float(r_val) if not r_val.startswith(".") else float("0" + r_val)

        # Extract means
        for match in self.PATTERNS["mean"].finditer(description):
            values["means"].append(float(match.group(1)))

        # Extract standard deviations
        for match in self.PATTERNS["sd"].finditer(description):
            values["sds"].append(float(match.group(1)))

        # Extract Cohen's d
        match = self.PATTERNS["cohens_d"].search(description)
        if match:
            values["cohens_d"] = float(match.group(1))

        # Extract effect size
        match = self.PATTERNS["effect_size"].search(description)
        if match:
            values["effect_size"] = float(match.group(1))

        return values

    def _generate_table(self, result_type: str, values: Dict, description: str) -> str:
        """Dispatch to type-specific table generator."""
        generators = {
            "regression": self._regression_table,
            "ttest": self._ttest_table,
            "correlation": self._correlation_table,
            "descriptive": self._descriptive_table,
            "anova": self._anova_table,
        }
        generator = generators.get(result_type, self._descriptive_table)
        return generator(values, description)

    def _generate_prose(self, result_type: str, values: Dict, description: str) -> str:
        """Dispatch to type-specific prose generator."""
        generators = {
            "regression": self._regression_prose,
            "ttest": self._ttest_prose,
            "correlation": self._correlation_prose,
            "descriptive": self._descriptive_prose,
            "anova": self._anova_prose,
        }
        generator = generators.get(result_type, self._descriptive_prose)
        return generator(values, description)

    # --- Table Generators ---

    def _regression_table(self, values: Dict, description: str) -> str:
        """Generate APA regression table."""
        lines = [
            "*Table 1*",
            "",
            "*Multiple Regression Results*",
            "",
            "| Predictor | *B* | *p* |",
            "|:----------|----:|----:|",
        ]

        for coef in values["coefficients"]:
            predictor = coef["predictor"].title()
            b_val = f"{coef['value']:.2f}"
            p_val = self._format_p(coef.get("p_value"), coef.get("p_operator"))
            lines.append(f"| {predictor} | {b_val} | {p_val} |")

        # Add model summary
        lines.append("")
        if values["r_squared"] is not None:
            lines.append(f"*Note.* *R*² = {values['r_squared']:.2f}")
            if values["f_stat"] is not None:
                lines[-1] += f", *F* = {values['f_stat']:.2f}"
            if values["n"] is not None:
                lines[-1] += f", *N* = {values['n']}"
            lines[-1] += "."

        return "\n".join(lines)

    def _ttest_table(self, values: Dict, description: str) -> str:
        """Generate APA t-test table."""
        lines = [
            "*Table 1*",
            "",
            "*T-Test Results*",
            "",
            "| Statistic | Value |",
            "|:----------|------:|",
        ]

        if values["t_stat"] is not None:
            lines.append(f"| *t* | {values['t_stat']:.2f} |")
        if values["df"]:
            lines.append(f"| *df* | {values['df']} |")
        if values["p_values"]:
            p = values["p_values"][0]
            lines.append(f"| *p* | {self._format_p(p['value'], p['operator'])} |")
        if values["cohens_d"] is not None:
            lines.append(f"| *d* | {values['cohens_d']:.2f} |")
        if values["n"] is not None:
            lines.append(f"| *N* | {values['n']} |")

        return "\n".join(lines)

    def _correlation_table(self, values: Dict, description: str) -> str:
        """Generate APA correlation table."""
        lines = [
            "*Table 1*",
            "",
            "*Correlation Results*",
            "",
            "| Statistic | Value |",
            "|:----------|------:|",
        ]

        if values["correlation"] is not None:
            lines.append(f"| *r* | {values['correlation']:.2f} |")
        if values["p_values"]:
            p = values["p_values"][0]
            lines.append(f"| *p* | {self._format_p(p['value'], p['operator'])} |")
        if values["n"] is not None:
            lines.append(f"| *N* | {values['n']} |")

        return "\n".join(lines)

    def _descriptive_table(self, values: Dict, description: str) -> str:
        """Generate APA descriptive statistics table."""
        lines = [
            "*Table 1*",
            "",
            "*Descriptive Statistics*",
            "",
            "| Variable | *M* | *SD* |",
            "|:---------|----:|-----:|",
        ]

        # Pair means and SDs
        means = values["means"]
        sds = values["sds"]

        if means and sds:
            for i, (m, sd) in enumerate(zip(means, sds)):
                lines.append(f"| Variable {i+1} | {m:.2f} | {sd:.2f} |")
        elif means:
            for i, m in enumerate(means):
                lines.append(f"| Variable {i+1} | {m:.2f} | — |")

        if values["n"] is not None:
            lines.append("")
            lines.append(f"*Note.* *N* = {values['n']}.")

        return "\n".join(lines)

    def _anova_table(self, values: Dict, description: str) -> str:
        """Generate APA ANOVA table."""
        lines = [
            "*Table 1*",
            "",
            "*ANOVA Results*",
            "",
            "| Source | *F* | *p* |",
            "|:-------|----:|----:|",
        ]

        if values["f_stat"] is not None:
            p_str = "—"
            if values["p_values"]:
                p = values["p_values"][0]
                p_str = self._format_p(p["value"], p["operator"])
            lines.append(f"| Effect | {values['f_stat']:.2f} | {p_str} |")

        if values["n"] is not None:
            lines.append("")
            lines.append(f"*Note.* *N* = {values['n']}.")

        return "\n".join(lines)

    # --- Prose Generators ---

    def _regression_prose(self, values: Dict, description: str) -> str:
        """Generate APA regression prose."""
        parts = []

        # Model summary
        if values["r_squared"] is not None:
            model_part = f"The regression model explained {values['r_squared']*100:.1f}% of the variance"
            if values["f_stat"] is not None:
                p_str = ""
                if values["p_values"]:
                    p = values["p_values"][0]
                    p_str = f", {self._format_p_inline(p['value'], p['operator'])}"
                model_part += f", *F* = {values['f_stat']:.2f}{p_str}"
            model_part += "."
            parts.append(model_part)

        # Coefficients
        for coef in values["coefficients"]:
            predictor = coef["predictor"].lower()
            b_val = coef["value"]
            direction = "positively" if b_val > 0 else "negatively"

            coef_part = f"{predictor.title()} was {direction} associated with the outcome, *B* = {b_val:.2f}"
            if coef.get("p_value") is not None:
                coef_part += f", {self._format_p_inline(coef['p_value'], coef.get('p_operator', '='))}"
            coef_part += "."
            parts.append(coef_part)

        return " ".join(parts)

    def _ttest_prose(self, values: Dict, description: str) -> str:
        """Generate APA t-test prose."""
        parts = []

        if values["t_stat"] is not None:
            # Determine significance based on p-value
            if values["p_values"]:
                p = values["p_values"][0]
                is_significant = p["value"] < 0.05
                if is_significant:
                    stat_part = "The *t*-test was statistically significant, *t*"
                else:
                    stat_part = "The *t*-test was not statistically significant, *t*"
            else:
                # No p-value available - use neutral phrasing
                stat_part = "The *t*-test results were *t*"

            if values["df"]:
                stat_part += f"({values['df']})"
            stat_part += f" = {values['t_stat']:.2f}"
            if values["p_values"]:
                p = values["p_values"][0]
                stat_part += f", {self._format_p_inline(p['value'], p['operator'])}"
            if values["cohens_d"] is not None:
                stat_part += f", *d* = {values['cohens_d']:.2f}"
            stat_part += "."
            parts.append(stat_part)

        return " ".join(parts) if parts else "Results are presented in the table above."

    def _correlation_prose(self, values: Dict, description: str) -> str:
        """Generate APA correlation prose."""
        if values["correlation"] is None:
            return "Correlation results are presented in the table above."

        r = values["correlation"]
        strength = self._interpret_correlation(abs(r))

        if r > 0:
            direction = "positive"
        elif r < 0:
            direction = "negative"
        else:
            direction = None

        if direction:
            prose = f"There was a {strength} {direction} correlation, *r* = {r:.2f}"
        else:
            prose = f"There was no correlation, *r* = {r:.2f}"
        if values["p_values"]:
            p = values["p_values"][0]
            prose += f", {self._format_p_inline(p['value'], p['operator'])}"
        if values["n"] is not None:
            prose += f", *N* = {values['n']}"
        prose += "."

        return prose

    def _descriptive_prose(self, values: Dict, description: str) -> str:
        """Generate APA descriptive statistics prose."""
        parts = []

        means = values["means"]
        sds = values["sds"]

        if means and sds and len(means) == len(sds):
            for i, (m, sd) in enumerate(zip(means, sds)):
                parts.append(f"Variable {i+1}: *M* = {m:.2f}, *SD* = {sd:.2f}")
        elif means:
            for i, m in enumerate(means):
                parts.append(f"Variable {i+1}: *M* = {m:.2f}")

        if not parts:
            return "Descriptive statistics are presented in the table above."

        prose = self._join_list(parts)
        if values["n"] is not None:
            prose += f" (*N* = {values['n']})"
        prose += "."

        return prose

    def _anova_prose(self, values: Dict, description: str) -> str:
        """Generate APA ANOVA prose."""
        if values["f_stat"] is None:
            return "ANOVA results are presented in the table above."

        # Determine significance based on p-value
        if values["p_values"]:
            p = values["p_values"][0]
            is_significant = p["value"] < 0.05
            if is_significant:
                prose = f"The ANOVA revealed a significant effect, *F* = {values['f_stat']:.2f}"
            else:
                prose = f"The ANOVA did not reveal a significant effect, *F* = {values['f_stat']:.2f}"
        else:
            # No p-value available - use neutral phrasing
            prose = f"The ANOVA results were *F* = {values['f_stat']:.2f}"

        if values["p_values"]:
            p = values["p_values"][0]
            prose += f", {self._format_p_inline(p['value'], p['operator'])}"
        prose += "."

        return prose

    # --- Helpers ---

    def _format_p(self, p_value: Optional[float], operator: Optional[str] = None) -> str:
        """Format p-value for table cells (APA style)."""
        if p_value is None:
            return "—"

        # APA: report exact p-values to 2-3 decimal places, use < .001 for very small
        if p_value < 0.001:
            return "< .001"
        elif p_value <= 0.001:
            return ".001"
        else:
            # Format to 3 decimal places, strip leading zero
            return f"{p_value:.3f}".lstrip("0")

    def _format_p_inline(self, p_value: float, operator: Optional[str] = None) -> str:
        """Format p-value for inline prose (APA style)."""
        if p_value < 0.001:
            return "*p* < .001"
        elif p_value <= 0.001:
            return "*p* = .001"
        else:
            # Format to 3 decimal places, strip leading zero
            p_str = f"{p_value:.3f}".lstrip("0")
            return f"*p* = {p_str}"

    def _join_list(self, items: List[str]) -> str:
        """Join list items with Oxford comma."""
        if len(items) == 0:
            return ""
        elif len(items) == 1:
            return items[0]
        elif len(items) == 2:
            return f"{items[0]} and {items[1]}"
        else:
            return ", ".join(items[:-1]) + f", and {items[-1]}"

    def _interpret_correlation(self, r: float) -> str:
        """Interpret correlation strength per Cohen's conventions."""
        if r >= 0.5:
            return "strong"
        elif r >= 0.3:
            return "moderate"
        elif r >= 0.1:
            return "weak"
        else:
            return "negligible"
