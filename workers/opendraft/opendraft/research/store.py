"""Research result storage with APA-formatted output.

Dataclasses for structured statistical results (regression, t-test, correlation, etc.)
and ResearchStore for managing ingested results.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Union


# =============================================================================
# FORMATTING HELPERS
# =============================================================================

def _format_p(p: float) -> str:
    """Format p-value for APA table (with significance stars)."""
    if p < 0.001:
        return "< .001***"
    elif p < 0.01:
        return f".{int(p*1000):03d}**"
    elif p < 0.05:
        return f".{int(p*1000):03d}*"
    else:
        return f".{int(p*1000):03d}"


def _format_p_inline(p: float) -> str:
    """Format p-value for inline prose."""
    if p < 0.001:
        return "p < .001"
    elif p < 0.01:
        return "p < .01"
    elif p < 0.05:
        return "p < .05"
    else:
        return f"p = .{int(p*1000):03d}"


def _format_num(val: Optional[float], decimals: int = 2) -> str:
    """Format a number with specified decimal places."""
    if val is None:
        return "—"
    return f"{val:.{decimals}f}"


def _format_coefficient(val: float, decimals: int = 2) -> str:
    """Format coefficient, removing leading zero for values < 1."""
    formatted = f"{val:.{decimals}f}"
    if abs(val) < 1:
        if val >= 0:
            return formatted.lstrip('0')
        else:
            return '-' + formatted.lstrip('-0')
    return formatted


def _join_list(items: List[str], conjunction: str = "and") -> str:
    """Join list with Oxford comma."""
    if len(items) == 0:
        return ""
    elif len(items) == 1:
        return items[0]
    elif len(items) == 2:
        return f"{items[0]} {conjunction} {items[1]}"
    else:
        return f"{', '.join(items[:-1])}, {conjunction} {items[-1]}"


def _interpret_correlation(r: float) -> str:
    """Interpret correlation strength (Cohen's conventions)."""
    abs_r = abs(r)
    if abs_r < 0.1:
        return "negligible"
    elif abs_r < 0.3:
        return "weak"
    elif abs_r < 0.5:
        return "moderate"
    elif abs_r < 0.7:
        return "strong"
    else:
        return "very strong"


def _interpret_cohens_d(d: float) -> str:
    """Interpret Cohen's d effect size."""
    abs_d = abs(d)
    if abs_d < 0.2:
        return "negligible"
    elif abs_d < 0.5:
        return "small"
    elif abs_d < 0.8:
        return "medium"
    else:
        return "large"


# =============================================================================
# RESULT DATACLASSES
# =============================================================================

@dataclass
class Predictor:
    """Single predictor in a regression model."""
    name: str
    coef: float
    se: Optional[float] = None
    beta: Optional[float] = None
    t: Optional[float] = None
    p: Optional[float] = None
    ci_lower: Optional[float] = None
    ci_upper: Optional[float] = None


@dataclass
class RegressionResult:
    """Regression analysis result (OLS, logistic, hierarchical)."""
    id: str
    type: str  # ols, logistic, hierarchical
    dependent_var: str
    predictors: List[Predictor]
    r_squared: float
    n: int
    adj_r_squared: Optional[float] = None
    f_stat: Optional[float] = None
    f_p: Optional[float] = None
    model_note: Optional[str] = None

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted table."""
        lines = [
            f"**Table {table_num}**",
            f"*Regression Results: Predictors of {self.dependent_var.replace('_', ' ').title()}*",
            "",
            "| Variable | B | SE | t | p |",
            "|----------|---|----|---|---|",
        ]

        for pred in self.predictors:
            b = _format_coefficient(pred.coef)
            se = _format_num(pred.se) if pred.se else "—"

            # Calculate t if not provided but we have se
            t_val = pred.t
            if t_val is None and pred.se and pred.se != 0:
                t_val = pred.coef / pred.se
            t = _format_num(t_val) if t_val else "—"

            p = _format_p(pred.p) if pred.p is not None else "—"
            name = pred.name.replace('_', ' ').title()
            lines.append(f"| {name} | {b} | {se} | {t} | {p} |")

        # Model fit note
        note_parts = [f"N = {self.n}", f"R² = {_format_coefficient(self.r_squared)}"]
        if self.adj_r_squared is not None:
            note_parts.append(f"Adj. R² = {_format_coefficient(self.adj_r_squared)}")
        if self.f_stat is not None:
            f_p_str = _format_p_inline(self.f_p) if self.f_p else ""
            note_parts.append(f"F = {_format_num(self.f_stat)}, {f_p_str}")

        lines.append("")
        lines.append(f"*Note.* {'. '.join(note_parts)}.")
        if self.model_note:
            lines.append(f"*{self.model_note}*")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose describing the results."""
        analysis_type = {
            "ols": "A multiple regression analysis",
            "logistic": "A logistic regression analysis",
            "hierarchical": "A hierarchical regression analysis",
        }.get(self.type, "A regression analysis")

        prose = f"{analysis_type} was conducted to examine the predictors of {self.dependent_var.replace('_', ' ')}. "

        if self.f_stat and self.f_p is not None:
            if self.f_p < 0.05:
                prose += f"The model was statistically significant, F = {_format_num(self.f_stat)}, {_format_p_inline(self.f_p)}, "
            else:
                prose += f"The model was not statistically significant, F = {_format_num(self.f_stat)}, {_format_p_inline(self.f_p)}, "
            prose += f"explaining {self.r_squared * 100:.1f}% of the variance (R² = {_format_coefficient(self.r_squared)}). "

        sig_predictors = [p for p in self.predictors if p.p is not None and p.p < 0.05]
        nonsig_predictors = [p for p in self.predictors if p.p is not None and p.p >= 0.05]

        if sig_predictors:
            pred_descriptions = []
            for pred in sig_predictors:
                desc = f"{pred.name.replace('_', ' ')} (B = {_format_coefficient(pred.coef)}, {_format_p_inline(pred.p)})"
                pred_descriptions.append(desc)
            prose += f"Significant predictors included {_join_list(pred_descriptions)}. "

        if nonsig_predictors:
            names = [p.name.replace('_', ' ') for p in nonsig_predictors]
            prose += f"{_join_list(names).capitalize()} {'were' if len(names) > 1 else 'was'} not significant."

        return prose


@dataclass
class TTestResult:
    """T-test result (independent, paired, one-sample)."""
    id: str
    type: str  # independent, paired, one_sample
    group1: str
    mean1: float
    t: float
    df: float
    p: float
    group2: Optional[str] = None
    mean2: Optional[float] = None
    sd1: Optional[float] = None
    sd2: Optional[float] = None
    cohens_d: Optional[float] = None
    ci_lower: Optional[float] = None
    ci_upper: Optional[float] = None
    test_value: Optional[float] = None  # For one-sample t-test

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted table."""
        lines = [f"**Table {table_num}**"]

        if self.type == "independent":
            lines.append(f"*Independent Samples t-test: {self.group1} vs {self.group2}*")
            lines.extend([
                "",
                "| Group | M | SD | t | df | p | Cohen's d |",
                "|-------|---|----|---|----|----|-----------|",
                f"| {self.group1} | {_format_num(self.mean1)} | {_format_num(self.sd1)} | {_format_num(self.t)} | {_format_num(self.df, 0)} | {_format_p(self.p)} | {_format_num(self.cohens_d) if self.cohens_d else '—'} |",
                f"| {self.group2} | {_format_num(self.mean2)} | {_format_num(self.sd2)} | | | | |",
            ])
        elif self.type == "paired":
            lines.append(f"*Paired Samples t-test: {self.group1} vs {self.group2}*")
            lines.extend([
                "",
                "| Condition | M | SD | t | df | p |",
                "|-----------|---|----|---|----|----|",
                f"| {self.group1} | {_format_num(self.mean1)} | {_format_num(self.sd1)} | {_format_num(self.t)} | {_format_num(self.df, 0)} | {_format_p(self.p)} |",
                f"| {self.group2} | {_format_num(self.mean2)} | {_format_num(self.sd2)} | | | |",
            ])
        else:  # one_sample
            lines.append(f"*One-Sample t-test: {self.group1}*")
            lines.extend([
                "",
                "| Variable | M | SD | Test Value | t | df | p |",
                "|----------|---|----|------------|---|----|----|",
                f"| {self.group1} | {_format_num(self.mean1)} | {_format_num(self.sd1)} | {_format_num(self.test_value)} | {_format_num(self.t)} | {_format_num(self.df, 0)} | {_format_p(self.p)} |",
            ])

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose describing the results."""
        sig_word = "significant" if self.p < 0.05 else "not significant"

        if self.type == "independent":
            prose = f"An independent samples t-test was conducted to compare {self.group1.lower()} and {self.group2.lower()}. "
            prose += f"There was a {sig_word} difference, t({self.df:.0f}) = {_format_num(self.t)}, {_format_p_inline(self.p)}"
            if self.cohens_d is not None:
                effect = _interpret_cohens_d(self.cohens_d)
                prose += f", with a {effect} effect size (d = {_format_num(self.cohens_d)})"
            prose += ". "
            prose += f"The {self.group1.lower()} group (M = {_format_num(self.mean1)}, SD = {_format_num(self.sd1)}) "
            if self.mean1 > self.mean2:
                prose += f"scored higher than the {self.group2.lower()} group (M = {_format_num(self.mean2)}, SD = {_format_num(self.sd2)})."
            else:
                prose += f"scored lower than the {self.group2.lower()} group (M = {_format_num(self.mean2)}, SD = {_format_num(self.sd2)})."

        elif self.type == "paired":
            prose = f"A paired samples t-test was conducted to compare {self.group1.lower()} and {self.group2.lower()}. "
            prose += f"There was a {sig_word} difference, t({self.df:.0f}) = {_format_num(self.t)}, {_format_p_inline(self.p)}. "
            prose += "Participants scored "
            if self.mean1 > self.mean2:
                prose += f"higher in the {self.group1.lower()} condition (M = {_format_num(self.mean1)}, SD = {_format_num(self.sd1)}) "
                prose += f"than in the {self.group2.lower()} condition (M = {_format_num(self.mean2)}, SD = {_format_num(self.sd2)})."
            else:
                prose += f"lower in the {self.group1.lower()} condition (M = {_format_num(self.mean1)}, SD = {_format_num(self.sd1)}) "
                prose += f"than in the {self.group2.lower()} condition (M = {_format_num(self.mean2)}, SD = {_format_num(self.sd2)})."

        else:  # one_sample
            prose = f"A one-sample t-test was conducted to determine whether {self.group1.lower()} "
            prose += f"differed from the test value of {_format_num(self.test_value)}. "
            prose += f"The result was {sig_word}, t({self.df:.0f}) = {_format_num(self.t)}, {_format_p_inline(self.p)}. "
            prose += f"The mean (M = {_format_num(self.mean1)}, SD = {_format_num(self.sd1)}) was "
            if self.mean1 > (self.test_value or 0):
                prose += "higher than the test value."
            else:
                prose += "lower than the test value."

        return prose


@dataclass
class CorrelationResult:
    """Correlation analysis result."""
    id: str
    variables: List[str]
    matrix: List[List[float]]
    n: int
    method: str = "pearson"  # pearson, spearman
    p_values: Optional[List[List[float]]] = None

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted correlation table."""
        method_name = "Pearson" if self.method == "pearson" else "Spearman"

        lines = [
            f"**Table {table_num}**",
            f"*{method_name} Correlations Among Study Variables*",
            "",
        ]

        # Header row
        header = "| Variable | " + " | ".join([f"{i+1}" for i in range(len(self.variables))]) + " |"
        separator = "|" + "---|" * (len(self.variables) + 1)
        lines.extend([header, separator])

        # Data rows
        for i, var in enumerate(self.variables):
            row_vals = []
            for j in range(len(self.variables)):
                if i == j:
                    row_vals.append("—")
                elif j < i:
                    r = self.matrix[i][j]
                    r_str = _format_coefficient(r)
                    if self.p_values and self.p_values[i][j] is not None:
                        p = self.p_values[i][j]
                        if p < 0.001:
                            r_str += "***"
                        elif p < 0.01:
                            r_str += "**"
                        elif p < 0.05:
                            r_str += "*"
                    row_vals.append(r_str)
                else:
                    row_vals.append("")
            lines.append(f"| {i+1}. {var} | " + " | ".join(row_vals) + " |")

        lines.append("")
        lines.append(f"*Note.* N = {self.n}. *p < .05. **p < .01. ***p < .001.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for notable correlations."""
        method_name = "Pearson" if self.method == "pearson" else "Spearman"
        prose = f"A {method_name} correlation analysis was conducted among {len(self.variables)} variables (N = {self.n}). "

        sig_correlations = []
        for i in range(len(self.variables)):
            for j in range(i):
                r = self.matrix[i][j]
                p = self.p_values[i][j] if self.p_values else None
                if p is not None and p < 0.05:
                    strength = _interpret_correlation(r)
                    direction = "positive" if r > 0 else "negative"
                    sig_correlations.append({
                        "var1": self.variables[i],
                        "var2": self.variables[j],
                        "r": r,
                        "p": p,
                        "strength": strength,
                        "direction": direction,
                    })

        if sig_correlations:
            sig_correlations.sort(key=lambda x: abs(x["r"]), reverse=True)
            descriptions = []
            for corr in sig_correlations[:5]:
                desc = f"{corr['var1']} and {corr['var2']} (r = {_format_coefficient(corr['r'])}, {_format_p_inline(corr['p'])})"
                descriptions.append(desc)
            prose += f"Significant correlations were found between {_join_list(descriptions)}."
        else:
            prose += "No significant correlations were found among the study variables."

        return prose


@dataclass
class DescriptivesResult:
    """Descriptive statistics result."""
    id: str
    variables: List[Dict]  # Each: {name, mean, sd, min, max, n, skewness?, kurtosis?}
    by_group: Optional[str] = None

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted descriptives table."""
        title = "Descriptive Statistics"
        if self.by_group:
            title += f" by {self.by_group}"

        lines = [
            f"**Table {table_num}**",
            f"*{title}*",
            "",
            "| Variable | M | SD | Min | Max | N |",
            "|----------|---|----|----|-----|---|",
        ]

        for var in self.variables:
            name = var.get("name", "Unknown").replace("_", " ").title()
            mean = _format_num(var.get("mean"))
            sd = _format_num(var.get("sd"))
            min_val = _format_num(var.get("min"))
            max_val = _format_num(var.get("max"))
            n = var.get("n", "—")
            lines.append(f"| {name} | {mean} | {sd} | {min_val} | {max_val} | {n} |")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose describing the descriptives."""
        n_vars = len(self.variables)
        prose = f"Descriptive statistics were computed for {n_vars} variable{'s' if n_vars > 1 else ''}. "

        var_descriptions = []
        for var in self.variables:
            name = var.get("name", "unknown").replace("_", " ")
            mean = _format_num(var.get("mean"))
            sd = _format_num(var.get("sd"))
            var_descriptions.append(f"{name} (M = {mean}, SD = {sd})")

        prose += f"Results indicated the following: {_join_list(var_descriptions, 'and')}."
        return prose


@dataclass
class ThemeResult:
    """Qualitative thematic analysis result."""
    id: str
    method: str  # thematic, content, grounded
    themes: List[Dict]  # Each: {name, description, frequency, quotes: []}
    total_participants: int

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted themes table."""
        method_name = {
            "thematic": "Thematic Analysis",
            "content": "Content Analysis",
            "grounded": "Grounded Theory",
        }.get(self.method, "Qualitative Analysis")

        lines = [
            f"**Table {table_num}**",
            f"*{method_name} Themes*",
            "",
            "| Theme | Description | Frequency | Example Quote |",
            "|-------|-------------|-----------|---------------|",
        ]

        for theme in self.themes:
            name = theme.get("name", "Unknown Theme")
            desc = theme.get("description", "")[:50] + ("..." if len(theme.get("description", "")) > 50 else "")
            freq = theme.get("frequency", "—")
            if isinstance(freq, int):
                freq = f"{freq} ({freq/self.total_participants*100:.0f}%)"
            quotes = theme.get("quotes", [])
            quote = f'"{quotes[0][:40]}..."' if quotes else "—"
            lines.append(f"| {name} | {desc} | {freq} | {quote} |")

        lines.append("")
        lines.append(f"*Note.* N = {self.total_participants} participants.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose describing the themes."""
        method_name = {
            "thematic": "Thematic analysis",
            "content": "Content analysis",
            "grounded": "Grounded theory analysis",
        }.get(self.method, "Qualitative analysis")

        prose = f"{method_name} of participant responses (N = {self.total_participants}) revealed {len(self.themes)} main themes. "

        theme_descriptions = []
        for theme in self.themes:
            name = theme.get("name", "Unknown")
            freq = theme.get("frequency")
            if isinstance(freq, int):
                pct = freq / self.total_participants * 100
                theme_descriptions.append(f"{name} ({pct:.0f}% of participants)")
            else:
                theme_descriptions.append(name)

        prose += f"These themes included: {_join_list(theme_descriptions)}. "

        for theme in self.themes[:3]:
            if theme.get("description"):
                prose += f"{theme['name']} was characterized by {theme['description'].lower()}. "

        return prose


@dataclass
class AnovaResult:
    """One-way ANOVA result with optional post-hoc tests."""
    id: str
    dependent_var: str
    group_var: str
    groups: List[Dict]  # Each: {name, mean, sd, n}
    f_stat: float
    df_between: int
    df_within: int
    p: float
    eta_squared: Optional[float] = None
    post_hoc: Optional[List[Dict]] = None  # Each: {group1, group2, diff, p, significant}

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted ANOVA table."""
        lines = [
            f"**Table {table_num}**",
            f"*One-Way ANOVA: {self.dependent_var.replace('_', ' ').title()} by {self.group_var.replace('_', ' ').title()}*",
            "",
            "| Group | M | SD | N |",
            "|-------|---|----|---|",
        ]

        for group in self.groups:
            name = group.get("name", "Unknown")
            mean = _format_num(group.get("mean"))
            sd = _format_num(group.get("sd"))
            n = group.get("n", "—")
            lines.append(f"| {name} | {mean} | {sd} | {n} |")

        lines.append("")
        p_str = _format_p(self.p)
        eta_str = f" η² = {_format_coefficient(self.eta_squared)}." if self.eta_squared else ""
        lines.append(f"*Note.* F({self.df_between}, {self.df_within}) = {_format_num(self.f_stat)}, p = {p_str}.{eta_str}")

        # Post-hoc table if available
        if self.post_hoc:
            lines.extend([
                "",
                "**Post-Hoc Comparisons (Tukey HSD)**",
                "",
                "| Comparison | Mean Diff | p |",
                "|------------|-----------|---|",
            ])
            for ph in self.post_hoc:
                comp = f"{ph['group1']} vs {ph['group2']}"
                diff = _format_num(ph.get("diff"))
                p_val = _format_p(ph.get("p", 1.0))
                lines.append(f"| {comp} | {diff} | {p_val} |")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for ANOVA results."""
        sig = "significant" if self.p < 0.05 else "not significant"
        prose = f"A one-way ANOVA was conducted to examine differences in {self.dependent_var.replace('_', ' ')} across {len(self.groups)} groups ({self.group_var.replace('_', ' ')}). "
        prose += f"The analysis was {sig}, F({self.df_between}, {self.df_within}) = {_format_num(self.f_stat)}, {_format_p_inline(self.p)}"

        if self.eta_squared:
            effect = "small" if self.eta_squared < 0.06 else "medium" if self.eta_squared < 0.14 else "large"
            prose += f", with a {effect} effect size (η² = {_format_coefficient(self.eta_squared)})"
        prose += ". "

        if self.post_hoc and self.p < 0.05:
            sig_comparisons = [ph for ph in self.post_hoc if ph.get("p", 1.0) < 0.05]
            if sig_comparisons:
                comparisons = [f"{ph['group1']} vs {ph['group2']}" for ph in sig_comparisons]
                prose += f"Post-hoc comparisons revealed significant differences between {_join_list(comparisons)}."

        return prose


@dataclass
class ChiSquareResult:
    """Chi-square test of independence result."""
    id: str
    var1: str
    var2: str
    contingency_table: List[List[int]]  # rows x cols counts
    row_labels: List[str]
    col_labels: List[str]
    chi_square: float
    df: int
    p: float
    cramers_v: Optional[float] = None
    n: int = 0

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted contingency table."""
        lines = [
            f"**Table {table_num}**",
            f"*Contingency Table: {self.var1.replace('_', ' ').title()} × {self.var2.replace('_', ' ').title()}*",
            "",
        ]

        # Header row
        header = f"| {self.var1} | " + " | ".join(self.col_labels) + " | Total |"
        sep = "|" + "---|" * (len(self.col_labels) + 2)
        lines.extend([header, sep])

        # Data rows
        for i, row_label in enumerate(self.row_labels):
            row_data = self.contingency_table[i]
            row_total = sum(row_data)
            row_str = f"| {row_label} | " + " | ".join(str(v) for v in row_data) + f" | {row_total} |"
            lines.append(row_str)

        # Column totals
        col_totals = [sum(self.contingency_table[i][j] for i in range(len(self.row_labels))) for j in range(len(self.col_labels))]
        grand_total = sum(col_totals)
        total_row = "| **Total** | " + " | ".join(f"**{t}**" for t in col_totals) + f" | **{grand_total}** |"
        lines.append(total_row)

        lines.append("")
        p_str = _format_p(self.p)
        v_str = f" Cramér's V = {_format_coefficient(self.cramers_v)}." if self.cramers_v else ""
        lines.append(f"*Note.* χ²({self.df}) = {_format_num(self.chi_square)}, p = {p_str}.{v_str}")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for chi-square results."""
        sig = "significant" if self.p < 0.05 else "not significant"
        prose = f"A chi-square test of independence was conducted to examine the relationship between {self.var1.replace('_', ' ')} and {self.var2.replace('_', ' ')} (N = {self.n}). "
        prose += f"The analysis was {sig}, χ²({self.df}) = {_format_num(self.chi_square)}, {_format_p_inline(self.p)}"

        if self.cramers_v:
            effect = "small" if self.cramers_v < 0.1 else "medium" if self.cramers_v < 0.3 else "large"
            prose += f", with a {effect} effect size (V = {_format_coefficient(self.cramers_v)})"
        prose += "."

        return prose


# =============================================================================
# PHASE 2b: EXTENDED ANALYSIS RESULTS
# =============================================================================

@dataclass
class LogisticPredictor:
    """Single predictor in a logistic regression model."""
    name: str
    coef: float  # Log-odds coefficient
    se: Optional[float] = None
    z: Optional[float] = None  # Wald z-statistic
    p: Optional[float] = None
    odds_ratio: Optional[float] = None
    ci_lower: Optional[float] = None  # OR confidence interval
    ci_upper: Optional[float] = None


@dataclass
class LogisticRegressionResult:
    """Logistic regression result with odds ratios."""
    id: str
    dependent_var: str
    predictors: List[LogisticPredictor]
    n: int
    n_events: int  # Number of "1" outcomes
    pseudo_r_squared: Optional[float] = None  # McFadden's R²
    log_likelihood: Optional[float] = None
    aic: Optional[float] = None
    chi_square: Optional[float] = None  # Model chi-square
    chi_p: Optional[float] = None

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted logistic regression table."""
        lines = [
            f"**Table {table_num}**",
            f"*Logistic Regression Results: Predictors of {self.dependent_var.replace('_', ' ').title()}*",
            "",
            "| Variable | B | SE | Wald | p | OR | 95% CI |",
            "|----------|---|----|------|---|----|---------| ",
        ]

        for pred in self.predictors:
            b = _format_coefficient(pred.coef)
            se = _format_num(pred.se) if pred.se else "—"
            z = _format_num(pred.z) if pred.z else "—"
            p = _format_p(pred.p) if pred.p is not None else "—"
            odds = _format_num(pred.odds_ratio) if pred.odds_ratio else "—"
            if pred.ci_lower and pred.ci_upper:
                ci = f"[{_format_num(pred.ci_lower)}, {_format_num(pred.ci_upper)}]"
            else:
                ci = "—"
            name = pred.name.replace('_', ' ').title()
            lines.append(f"| {name} | {b} | {se} | {z} | {p} | {odds} | {ci} |")

        lines.append("")
        note_parts = [f"N = {self.n}", f"Events = {self.n_events}"]
        if self.pseudo_r_squared:
            note_parts.append(f"McFadden R² = {_format_coefficient(self.pseudo_r_squared)}")
        if self.chi_square and self.chi_p:
            note_parts.append(f"Model χ² = {_format_num(self.chi_square)}, {_format_p_inline(self.chi_p)}")
        lines.append(f"*Note.* {'. '.join(note_parts)}.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for logistic regression."""
        prose = f"A logistic regression was conducted to predict {self.dependent_var.replace('_', ' ')} (N = {self.n}, {self.n_events} events). "

        if self.chi_square and self.chi_p:
            sig = "significant" if self.chi_p < 0.05 else "not significant"
            prose += f"The model was {sig}, χ² = {_format_num(self.chi_square)}, {_format_p_inline(self.chi_p)}"
            if self.pseudo_r_squared:
                prose += f", explaining approximately {self.pseudo_r_squared*100:.1f}% of variance (McFadden R²)"
            prose += ". "

        sig_predictors = [p for p in self.predictors if p.p and p.p < 0.05]
        if sig_predictors:
            pred_descriptions = []
            for p in sig_predictors:
                if p.odds_ratio:
                    pred_descriptions.append(
                        f"{p.name.replace('_', ' ')} (OR = {_format_num(p.odds_ratio)}, {_format_p_inline(p.p)})"
                    )
            prose += f"Significant predictors included {_join_list(pred_descriptions)}."

        return prose


@dataclass
class NonParametricResult:
    """Non-parametric test result (Mann-Whitney, Kruskal-Wallis, Wilcoxon)."""
    id: str
    test_type: str  # mann_whitney, kruskal_wallis, wilcoxon
    variable: str
    groups: Optional[List[Dict]] = None  # For between-subjects: {name, n, median, mean_rank}
    statistic: float = 0.0  # U, H, or W
    p: float = 1.0
    effect_size: Optional[float] = None  # r for Mann-Whitney/Wilcoxon, epsilon² for Kruskal-Wallis
    effect_name: Optional[str] = None  # "r" or "ε²"
    n: int = 0

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted non-parametric test table."""
        test_names = {
            "mann_whitney": "Mann-Whitney U Test",
            "kruskal_wallis": "Kruskal-Wallis H Test",
            "wilcoxon": "Wilcoxon Signed-Rank Test",
        }
        test_name = test_names.get(self.test_type, "Non-Parametric Test")
        stat_names = {"mann_whitney": "U", "kruskal_wallis": "H", "wilcoxon": "W"}
        stat_name = stat_names.get(self.test_type, "Statistic")

        lines = [
            f"**Table {table_num}**",
            f"*{test_name}: {self.variable.replace('_', ' ').title()}*",
            "",
        ]

        if self.groups:
            lines.extend([
                "| Group | N | Median | Mean Rank |",
                "|-------|---|--------|-----------|",
            ])
            for g in self.groups:
                lines.append(f"| {g['name']} | {g['n']} | {_format_num(g.get('median'))} | {_format_num(g.get('mean_rank'))} |")
            lines.append("")

        p_str = _format_p(self.p)
        effect_str = f" {self.effect_name} = {_format_coefficient(self.effect_size)}." if self.effect_size else ""
        lines.append(f"*Note.* {stat_name} = {_format_num(self.statistic)}, p = {p_str}.{effect_str}")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for non-parametric test."""
        test_phrases = {
            "mann_whitney": "A Mann-Whitney U test was conducted",
            "kruskal_wallis": "A Kruskal-Wallis H test was conducted",
            "wilcoxon": "A Wilcoxon signed-rank test was conducted",
        }
        stat_names = {"mann_whitney": "U", "kruskal_wallis": "H", "wilcoxon": "W"}

        prose = f"{test_phrases.get(self.test_type, 'A non-parametric test was conducted')} "
        prose += f"to examine differences in {self.variable.replace('_', ' ')}. "

        sig = "significant" if self.p < 0.05 else "not significant"
        stat_name = stat_names.get(self.test_type, "Statistic")
        prose += f"The analysis was {sig}, {stat_name} = {_format_num(self.statistic)}, {_format_p_inline(self.p)}"

        if self.effect_size and self.effect_name:
            effect_interp = "small" if abs(self.effect_size) < 0.3 else "medium" if abs(self.effect_size) < 0.5 else "large"
            prose += f", with a {effect_interp} effect size ({self.effect_name} = {_format_coefficient(self.effect_size)})"
        prose += "."

        return prose


@dataclass
class FactorialAnovaResult:
    """Two-way (factorial) ANOVA result with main effects and interaction."""
    id: str
    dependent_var: str
    factor1: str
    factor2: str
    factor1_levels: List[str]
    factor2_levels: List[str]
    main_effect1: Dict  # {f_stat, df, p, eta_squared}
    main_effect2: Dict  # {f_stat, df, p, eta_squared}
    interaction: Dict  # {f_stat, df, p, eta_squared}
    cell_means: List[List[Dict]]  # [factor1_level][factor2_level] = {mean, sd, n}
    n: int
    df_error: int

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted factorial ANOVA table."""
        lines = [
            f"**Table {table_num}**",
            f"*Two-Way ANOVA: {self.dependent_var.replace('_', ' ').title()}*",
            "",
            "| Source | SS | df | MS | F | p | η²p |",
            "|--------|----|----|----|----|---|-----|",
        ]

        for effect, name in [(self.main_effect1, self.factor1), (self.main_effect2, self.factor2),
                             (self.interaction, f"{self.factor1} × {self.factor2}")]:
            f = _format_num(effect.get('f_stat'))
            df = effect.get('df', '—')
            p = _format_p(effect.get('p', 1.0))
            eta = _format_coefficient(effect.get('eta_squared', 0)) if effect.get('eta_squared') else "—"
            lines.append(f"| {name} | — | {df} | — | {f} | {p} | {eta} |")

        lines.append(f"| Error | — | {self.df_error} | — | | | |")
        lines.append("")
        lines.append(f"*Note.* N = {self.n}. η²p = partial eta-squared.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for factorial ANOVA."""
        prose = f"A two-way ANOVA was conducted to examine the effects of {self.factor1.replace('_', ' ')} and {self.factor2.replace('_', ' ')} on {self.dependent_var.replace('_', ' ')}. "

        # Main effect 1
        e1 = self.main_effect1
        sig1 = "significant" if e1.get('p', 1) < 0.05 else "not significant"
        prose += f"The main effect of {self.factor1.replace('_', ' ')} was {sig1}, F({e1.get('df')}, {self.df_error}) = {_format_num(e1.get('f_stat'))}, {_format_p_inline(e1.get('p', 1))}. "

        # Main effect 2
        e2 = self.main_effect2
        sig2 = "significant" if e2.get('p', 1) < 0.05 else "not significant"
        prose += f"The main effect of {self.factor2.replace('_', ' ')} was {sig2}, F({e2.get('df')}, {self.df_error}) = {_format_num(e2.get('f_stat'))}, {_format_p_inline(e2.get('p', 1))}. "

        # Interaction
        inter = self.interaction
        sig_int = "significant" if inter.get('p', 1) < 0.05 else "not significant"
        prose += f"The interaction between {self.factor1.replace('_', ' ')} and {self.factor2.replace('_', ' ')} was {sig_int}, F({inter.get('df')}, {self.df_error}) = {_format_num(inter.get('f_stat'))}, {_format_p_inline(inter.get('p', 1))}."

        return prose


@dataclass
class RepeatedMeasuresResult:
    """Repeated measures ANOVA result."""
    id: str
    dependent_var: str
    within_factor: str
    levels: List[str]
    level_means: List[Dict]  # {name, mean, sd, n}
    f_stat: float
    df_effect: float  # May be corrected (Greenhouse-Geisser)
    df_error: float
    p: float
    eta_squared: Optional[float] = None
    sphericity_violated: bool = False
    epsilon: Optional[float] = None  # Greenhouse-Geisser epsilon
    mauchly_p: Optional[float] = None
    n: int = 0

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted repeated measures table."""
        lines = [
            f"**Table {table_num}**",
            f"*Repeated Measures ANOVA: {self.dependent_var.replace('_', ' ').title()}*",
            "",
            f"| {self.within_factor} | M | SD | N |",
            "|" + "----|" * 4,
        ]

        for lm in self.level_means:
            lines.append(f"| {lm['name']} | {_format_num(lm['mean'])} | {_format_num(lm['sd'])} | {lm['n']} |")

        lines.append("")
        correction = " (Greenhouse-Geisser corrected)" if self.sphericity_violated else ""
        eta_str = f" η²p = {_format_coefficient(self.eta_squared)}." if self.eta_squared else ""
        lines.append(f"*Note.* F({_format_num(self.df_effect, 2)}, {_format_num(self.df_error, 2)}) = {_format_num(self.f_stat)}, p = {_format_p(self.p)}{correction}.{eta_str}")

        if self.sphericity_violated and self.epsilon:
            lines.append(f"Sphericity violated (Mauchly's p = {_format_p(self.mauchly_p) if self.mauchly_p else '< .05'}), ε = {_format_coefficient(self.epsilon)}.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for repeated measures ANOVA."""
        prose = f"A repeated measures ANOVA was conducted to examine changes in {self.dependent_var.replace('_', ' ')} across {len(self.levels)} levels of {self.within_factor.replace('_', ' ')} (N = {self.n}). "

        if self.sphericity_violated:
            prose += f"Mauchly's test indicated sphericity was violated (p < .05), so Greenhouse-Geisser corrected values are reported (ε = {_format_coefficient(self.epsilon)}). "

        sig = "significant" if self.p < 0.05 else "not significant"
        prose += f"The effect was {sig}, F({_format_num(self.df_effect, 2)}, {_format_num(self.df_error, 2)}) = {_format_num(self.f_stat)}, {_format_p_inline(self.p)}"

        if self.eta_squared:
            effect_size = "small" if self.eta_squared < 0.06 else "medium" if self.eta_squared < 0.14 else "large"
            prose += f", with a {effect_size} effect size (η²p = {_format_coefficient(self.eta_squared)})"
        prose += "."

        return prose


@dataclass
class ReliabilityResult:
    """Reliability analysis result (Cronbach's alpha)."""
    id: str
    scale_name: str
    items: List[str]
    cronbachs_alpha: float
    n_items: int
    n_cases: int
    item_stats: Optional[List[Dict]] = None  # {name, item_total_r, alpha_if_deleted}
    mean_inter_item_r: Optional[float] = None

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted reliability table."""
        lines = [
            f"**Table {table_num}**",
            f"*Reliability Analysis: {self.scale_name}*",
            "",
        ]

        if self.item_stats:
            lines.extend([
                "| Item | Item-Total r | α if Deleted |",
                "|------|--------------|--------------|",
            ])
            for item in self.item_stats:
                lines.append(f"| {item['name']} | {_format_coefficient(item.get('item_total_r', 0))} | {_format_coefficient(item.get('alpha_if_deleted', 0))} |")
            lines.append("")

        lines.append(f"*Note.* Cronbach's α = {_format_coefficient(self.cronbachs_alpha)}. N = {self.n_cases}. {self.n_items} items.")
        if self.mean_inter_item_r:
            lines.append(f"Mean inter-item correlation = {_format_coefficient(self.mean_inter_item_r)}.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for reliability analysis."""
        # Interpret alpha
        if self.cronbachs_alpha >= 0.9:
            quality = "excellent"
        elif self.cronbachs_alpha >= 0.8:
            quality = "good"
        elif self.cronbachs_alpha >= 0.7:
            quality = "acceptable"
        elif self.cronbachs_alpha >= 0.6:
            quality = "questionable"
        elif self.cronbachs_alpha >= 0.5:
            quality = "poor"
        else:
            quality = "unacceptable"

        prose = f"Internal consistency reliability was assessed for the {self.scale_name} scale ({self.n_items} items, N = {self.n_cases}). "
        prose += f"Cronbach's alpha was {_format_coefficient(self.cronbachs_alpha)}, indicating {quality} reliability. "

        if self.item_stats:
            problematic = [s for s in self.item_stats if s.get('alpha_if_deleted', 0) > self.cronbachs_alpha + 0.02]
            if problematic:
                items = [s['name'] for s in problematic]
                prose += f"Removing {_join_list(items, 'or')} would improve reliability."

        return prose


# =============================================================================
# PHASE 3: ADVANCED ANALYSIS DATACLASSES
# =============================================================================

@dataclass
class MixedModelResult:
    """Mixed (multilevel/hierarchical) model result."""
    id: str
    dependent_var: str
    fixed_effects: List[Dict]  # {name, coef, se, z, p, ci_lower, ci_upper}
    random_effects: List[Dict]  # {group, variance, sd}
    group_var: str
    n_obs: int
    n_groups: int
    log_likelihood: Optional[float] = None
    aic: Optional[float] = None
    bic: Optional[float] = None
    icc: Optional[float] = None  # Intraclass correlation coefficient

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted mixed model table."""
        lines = [
            f"**Table {table_num}**",
            f"*Mixed Model Results: Predictors of {self.dependent_var.replace('_', ' ').title()}*",
            "",
            "**Fixed Effects**",
            "",
            "| Variable | B | SE | z | p | 95% CI |",
            "|----------|---|----|---|---|--------|",
        ]

        for fe in self.fixed_effects:
            ci_str = ""
            if fe.get('ci_lower') is not None and fe.get('ci_upper') is not None:
                ci_str = f"[{_format_coefficient(fe['ci_lower'])}, {_format_coefficient(fe['ci_upper'])}]"
            lines.append(
                f"| {fe['name'].replace('_', ' ').title()} | "
                f"{_format_coefficient(fe['coef'])} | "
                f"{_format_coefficient(fe.get('se'))} | "
                f"{_format_num(fe.get('z'))} | "
                f"{_format_p(fe.get('p'))} | {ci_str} |"
            )

        lines.extend(["", "**Random Effects**", ""])
        lines.extend([
            "| Group | Variance | SD |",
            "|-------|----------|----| ",
        ])
        for re in self.random_effects:
            lines.append(
                f"| {re['group']} | {_format_num(re.get('variance'))} | {_format_num(re.get('sd'))} |"
            )

        note_parts = [f"N = {self.n_obs}. Groups = {self.n_groups}."]
        if self.icc is not None:
            note_parts.append(f"ICC = {_format_coefficient(self.icc)}.")
        if self.aic is not None:
            note_parts.append(f"AIC = {_format_num(self.aic)}.")
        lines.append(f"\n*Note.* {' '.join(note_parts)}")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for mixed model."""
        prose = f"A mixed-effects model was estimated with {self.dependent_var.replace('_', ' ')} as the dependent variable "
        prose += f"and {self.group_var.replace('_', ' ')} as the grouping variable (N = {self.n_obs}, groups = {self.n_groups}). "

        if self.icc is not None:
            icc_pct = self.icc * 100
            prose += f"The intraclass correlation coefficient was {_format_coefficient(self.icc)}, indicating that {icc_pct:.1f}% of variance was between groups. "

        sig_effects = [fe for fe in self.fixed_effects if fe.get('p') and fe['p'] < 0.05 and fe['name'] != 'Intercept']
        if sig_effects:
            effect_descriptions = []
            for fe in sig_effects:
                effect_descriptions.append(f"{fe['name'].replace('_', ' ')} (B = {_format_coefficient(fe['coef'])}, {_format_p_inline(fe['p'])})")
            prose += f"Significant fixed effects included {_join_list(effect_descriptions)}."

        return prose


@dataclass
class ManovaResult:
    """Multivariate ANOVA result."""
    id: str
    dependent_vars: List[str]
    group_var: str
    groups: List[str]
    pillais_trace: float
    wilks_lambda: float
    f_stat: float
    df1: int
    df2: int
    p: float
    n: int
    univariate_results: List[Dict]  # {dv, f_stat, df1, df2, p, eta_squared}

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted MANOVA table."""
        lines = [
            f"**Table {table_num}**",
            f"*MANOVA Results: Effects of {self.group_var.replace('_', ' ').title()} on Multiple Outcomes*",
            "",
            "**Multivariate Tests**",
            "",
            "| Test | Value | F | df1 | df2 | p |",
            "|------|-------|---|-----|-----|---|",
            f"| Pillai's Trace | {_format_coefficient(self.pillais_trace)} | {_format_num(self.f_stat)} | {self.df1} | {self.df2} | {_format_p(self.p)} |",
            f"| Wilks' Lambda | {_format_coefficient(self.wilks_lambda)} | {_format_num(self.f_stat)} | {self.df1} | {self.df2} | {_format_p(self.p)} |",
            "",
            "**Univariate ANOVAs**",
            "",
            "| Dependent Variable | F | df | p | η² |",
            "|-------------------|---|----|----|-----|",
        ]

        for uv in self.univariate_results:
            lines.append(
                f"| {uv['dv'].replace('_', ' ').title()} | "
                f"{_format_num(uv['f_stat'])} | "
                f"({uv['df1']}, {uv['df2']}) | "
                f"{_format_p(uv['p'])} | "
                f"{_format_coefficient(uv.get('eta_squared'))} |"
            )

        lines.append(f"\n*Note.* N = {self.n}. Groups: {', '.join(self.groups)}.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for MANOVA."""
        n_dvs = len(self.dependent_vars)
        dv_names = _join_list([dv.replace('_', ' ') for dv in self.dependent_vars])

        prose = f"A one-way MANOVA was conducted to examine the effect of {self.group_var.replace('_', ' ')} "
        prose += f"on {n_dvs} dependent variables ({dv_names}). "

        sig = "significant" if self.p < 0.05 else "not significant"
        prose += f"The multivariate effect was {sig}, Pillai's Trace = {_format_coefficient(self.pillais_trace)}, "
        prose += f"F({self.df1}, {self.df2}) = {_format_num(self.f_stat)}, {_format_p_inline(self.p)}. "

        if self.p < 0.05:
            sig_univariate = [uv for uv in self.univariate_results if uv.get('p', 1) < 0.05]
            if sig_univariate:
                uv_descriptions = []
                for uv in sig_univariate:
                    uv_descriptions.append(
                        f"{uv['dv'].replace('_', ' ')} (F({uv['df1']}, {uv['df2']}) = {_format_num(uv['f_stat'])}, {_format_p_inline(uv['p'])})"
                    )
                prose += f"Follow-up univariate ANOVAs revealed significant effects for {_join_list(uv_descriptions)}."

        return prose


@dataclass
class MediationResult:
    """Mediation analysis result (Baron & Kenny approach)."""
    id: str
    x_var: str  # Independent variable
    m_var: str  # Mediator
    y_var: str  # Dependent variable
    path_a: Dict  # X → M: {coef, se, t, p}
    path_b: Dict  # M → Y: {coef, se, t, p}
    path_c: Dict  # X → Y (total): {coef, se, t, p}
    path_c_prime: Dict  # X → Y (direct): {coef, se, t, p}
    indirect_effect: float
    indirect_se: Optional[float] = None
    sobel_z: Optional[float] = None
    sobel_p: Optional[float] = None
    bootstrap_ci_lower: Optional[float] = None
    bootstrap_ci_upper: Optional[float] = None
    n: int = 0
    mediation_type: str = ""  # "full", "partial", "none"

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted mediation table."""
        lines = [
            f"**Table {table_num}**",
            f"*Mediation Analysis: {self.x_var.replace('_', ' ').title()} → {self.m_var.replace('_', ' ').title()} → {self.y_var.replace('_', ' ').title()}*",
            "",
            "| Path | B | SE | t | p |",
            "|------|---|----|---|---|",
            f"| a ({self.x_var} → {self.m_var}) | {_format_coefficient(self.path_a['coef'])} | "
            f"{_format_coefficient(self.path_a.get('se'))} | {_format_num(self.path_a.get('t'))} | "
            f"{_format_p(self.path_a.get('p'))} |",
            f"| b ({self.m_var} → {self.y_var}) | {_format_coefficient(self.path_b['coef'])} | "
            f"{_format_coefficient(self.path_b.get('se'))} | {_format_num(self.path_b.get('t'))} | "
            f"{_format_p(self.path_b.get('p'))} |",
            f"| c (Total effect) | {_format_coefficient(self.path_c['coef'])} | "
            f"{_format_coefficient(self.path_c.get('se'))} | {_format_num(self.path_c.get('t'))} | "
            f"{_format_p(self.path_c.get('p'))} |",
            f"| c' (Direct effect) | {_format_coefficient(self.path_c_prime['coef'])} | "
            f"{_format_coefficient(self.path_c_prime.get('se'))} | {_format_num(self.path_c_prime.get('t'))} | "
            f"{_format_p(self.path_c_prime.get('p'))} |",
            "",
        ]

        indirect_str = f"Indirect effect (a × b) = {_format_coefficient(self.indirect_effect)}"
        if self.sobel_z is not None and self.sobel_p is not None:
            indirect_str += f", Sobel z = {_format_num(self.sobel_z)}, {_format_p_inline(self.sobel_p)}"
        if self.bootstrap_ci_lower is not None and self.bootstrap_ci_upper is not None:
            indirect_str += f", 95% CI [{_format_coefficient(self.bootstrap_ci_lower)}, {_format_coefficient(self.bootstrap_ci_upper)}]"

        lines.append(f"*Note.* N = {self.n}. {indirect_str}.")

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for mediation."""
        prose = f"A mediation analysis was conducted to test whether {self.m_var.replace('_', ' ')} mediates "
        prose += f"the relationship between {self.x_var.replace('_', ' ')} and {self.y_var.replace('_', ' ')} (N = {self.n}). "

        # Path a
        a_sig = self.path_a.get('p', 1) < 0.05
        prose += f"The effect of {self.x_var.replace('_', ' ')} on {self.m_var.replace('_', ' ')} (path a) was "
        prose += f"{'significant' if a_sig else 'not significant'}, B = {_format_coefficient(self.path_a['coef'])}, {_format_p_inline(self.path_a.get('p'))}. "

        # Path b
        b_sig = self.path_b.get('p', 1) < 0.05
        prose += f"The effect of {self.m_var.replace('_', ' ')} on {self.y_var.replace('_', ' ')} controlling for {self.x_var.replace('_', ' ')} (path b) was "
        prose += f"{'significant' if b_sig else 'not significant'}, B = {_format_coefficient(self.path_b['coef'])}, {_format_p_inline(self.path_b.get('p'))}. "

        # Indirect effect
        prose += f"The indirect effect was {_format_coefficient(self.indirect_effect)}"
        if self.sobel_z is not None and self.sobel_p is not None:
            indirect_sig = self.sobel_p < 0.05
            prose += f", which was {'significant' if indirect_sig else 'not significant'} (Sobel z = {_format_num(self.sobel_z)}, {_format_p_inline(self.sobel_p)})"
        prose += ". "

        # Conclusion
        if self.mediation_type:
            prose += f"Results support {self.mediation_type} mediation."

        return prose


@dataclass
class ModerationResult:
    """Moderation analysis result (interaction effect)."""
    id: str
    x_var: str  # Independent variable
    w_var: str  # Moderator
    y_var: str  # Dependent variable
    main_x: Dict  # {coef, se, t, p}
    main_w: Dict  # {coef, se, t, p}
    interaction: Dict  # {coef, se, t, p}
    r_squared: float
    r_squared_change: float  # R² change due to interaction
    f_change: float
    f_change_p: float
    simple_slopes: Optional[List[Dict]] = None  # {level, slope, se, t, p}
    n: int = 0

    def to_apa_table(self, table_num: int = 1) -> str:
        """Generate APA-formatted moderation table."""
        lines = [
            f"**Table {table_num}**",
            f"*Moderation Analysis: {self.w_var.replace('_', ' ').title()} as Moderator of {self.x_var.replace('_', ' ').title()} → {self.y_var.replace('_', ' ').title()}*",
            "",
            "| Predictor | B | SE | t | p |",
            "|-----------|---|----|---|---|",
            f"| {self.x_var.replace('_', ' ').title()} | {_format_coefficient(self.main_x['coef'])} | "
            f"{_format_coefficient(self.main_x.get('se'))} | {_format_num(self.main_x.get('t'))} | "
            f"{_format_p(self.main_x.get('p'))} |",
            f"| {self.w_var.replace('_', ' ').title()} | {_format_coefficient(self.main_w['coef'])} | "
            f"{_format_coefficient(self.main_w.get('se'))} | {_format_num(self.main_w.get('t'))} | "
            f"{_format_p(self.main_w.get('p'))} |",
            f"| {self.x_var} × {self.w_var} | {_format_coefficient(self.interaction['coef'])} | "
            f"{_format_coefficient(self.interaction.get('se'))} | {_format_num(self.interaction.get('t'))} | "
            f"{_format_p(self.interaction.get('p'))} |",
            "",
        ]

        note = f"*Note.* N = {self.n}. R² = {_format_coefficient(self.r_squared)}. "
        note += f"ΔR² for interaction = {_format_coefficient(self.r_squared_change)}, "
        note += f"F change = {_format_num(self.f_change)}, {_format_p_inline(self.f_change_p)}."
        lines.append(note)

        if self.simple_slopes:
            lines.extend(["", "**Simple Slopes**", ""])
            lines.extend([
                "| Moderator Level | Slope | SE | t | p |",
                "|-----------------|-------|----|---|---|",
            ])
            for ss in self.simple_slopes:
                lines.append(
                    f"| {ss['level']} | {_format_coefficient(ss['slope'])} | "
                    f"{_format_coefficient(ss.get('se'))} | {_format_num(ss.get('t'))} | "
                    f"{_format_p(ss.get('p'))} |"
                )

        return "\n".join(lines)

    def to_apa_prose(self) -> str:
        """Generate APA prose for moderation."""
        prose = f"A moderation analysis was conducted to test whether {self.w_var.replace('_', ' ')} moderates "
        prose += f"the effect of {self.x_var.replace('_', ' ')} on {self.y_var.replace('_', ' ')} (N = {self.n}). "

        int_sig = self.interaction.get('p', 1) < 0.05
        prose += f"The interaction term was {'significant' if int_sig else 'not significant'}, "
        prose += f"B = {_format_coefficient(self.interaction['coef'])}, {_format_p_inline(self.interaction.get('p'))}, "
        prose += f"indicating that {self.w_var.replace('_', ' ')} {'does' if int_sig else 'does not'} moderate the relationship. "

        prose += f"Adding the interaction term explained an additional {self.r_squared_change*100:.1f}% of variance, "
        prose += f"F change = {_format_num(self.f_change)}, {_format_p_inline(self.f_change_p)}. "

        if self.simple_slopes and int_sig:
            prose += "Simple slopes analysis revealed: "
            slope_descriptions = []
            for ss in self.simple_slopes:
                sig = ss.get('p', 1) < 0.05
                slope_descriptions.append(
                    f"at {ss['level']} {self.w_var.replace('_', ' ')}, B = {_format_coefficient(ss['slope'])}, {'p < .05' if sig else 'ns'}"
                )
            prose += "; ".join(slope_descriptions) + "."

        return prose


@dataclass
class Figure:
    """Figure reference and caption."""
    id: str
    filename: str
    number: int
    title: str
    caption: str
    note: Optional[str] = None

    def to_apa_format(self) -> str:
        """Generate APA-formatted figure caption."""
        lines = [
            f"**Figure {self.number}**",
            "",
            f"*{self.title}*",
            "",
            self.caption,
        ]

        if self.note:
            lines.extend(["", f"*Note.* {self.note}"])

        return "\n".join(lines)


# =============================================================================
# TYPE ALIAS
# =============================================================================

ResearchResult = Union[
    RegressionResult,
    TTestResult,
    CorrelationResult,
    DescriptivesResult,
    ThemeResult,
    AnovaResult,
    ChiSquareResult,
    # Phase 2b: Extended analysis
    LogisticRegressionResult,
    NonParametricResult,
    FactorialAnovaResult,
    RepeatedMeasuresResult,
    ReliabilityResult,
    # Phase 3: Advanced analysis
    MixedModelResult,
    ManovaResult,
    MediationResult,
    ModerationResult,
]


# =============================================================================
# RESEARCH STORE
# =============================================================================

@dataclass
class ResearchStore:
    """Storage for research results and figures.

    Maintains ID counter and provides lookup by ID.
    """
    results: List[ResearchResult] = field(default_factory=list)
    figures: List[Figure] = field(default_factory=list)
    _result_counter: int = field(default=0, repr=False)
    _figure_counter: int = field(default=0, repr=False)

    def next_result_id(self) -> str:
        """Generate next result ID."""
        self._result_counter += 1
        return f"result_{self._result_counter:03d}"

    def next_figure_id(self) -> str:
        """Generate next figure ID."""
        self._figure_counter += 1
        return f"figure_{self._figure_counter:03d}"

    def add_result(self, result: ResearchResult) -> str:
        """Add a result to the store. Returns the result ID."""
        self.results.append(result)
        return result.id

    def add_figure(self, figure: Figure) -> str:
        """Add a figure to the store. Returns the figure ID."""
        self.figures.append(figure)
        return figure.id

    def get_result(self, result_id: str) -> Optional[ResearchResult]:
        """Get a result by ID."""
        for result in self.results:
            if result.id == result_id:
                return result
        return None

    def get_figure(self, figure_id: str) -> Optional[Figure]:
        """Get a figure by ID."""
        for figure in self.figures:
            if figure.id == figure_id:
                return figure
        return None

    def list_results(self) -> List[Dict]:
        """List all results with summary info."""
        summaries = []
        for result in self.results:
            summary = {
                "id": result.id,
                "type": type(result).__name__,
            }
            if isinstance(result, RegressionResult):
                summary["dependent_var"] = result.dependent_var
                summary["n_predictors"] = len(result.predictors)
            elif isinstance(result, TTestResult):
                summary["test_type"] = result.type
                summary["groups"] = [result.group1, result.group2] if result.group2 else [result.group1]
            elif isinstance(result, CorrelationResult):
                summary["n_variables"] = len(result.variables)
                summary["method"] = result.method
            elif isinstance(result, DescriptivesResult):
                summary["n_variables"] = len(result.variables)
                summary["by_group"] = result.by_group
            elif isinstance(result, ThemeResult):
                summary["n_themes"] = len(result.themes)
                summary["method"] = result.method
            summaries.append(summary)
        return summaries

    def list_figures(self) -> List[Dict]:
        """List all figures with summary info."""
        return [
            {
                "id": fig.id,
                "filename": fig.filename,
                "number": fig.number,
                "title": fig.title,
            }
            for fig in self.figures
        ]

    def clear(self) -> None:
        """Clear all results and figures."""
        self.results.clear()
        self.figures.clear()
        self._result_counter = 0
        self._figure_counter = 0
