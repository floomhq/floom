"""Data analysis operations for Phase 2.

Provides functions to analyze user-uploaded CSV data and automatically
ingest results into ResearchStore for APA formatting.
"""

import logging
import warnings
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
from scipy import stats

from opendraft.research import IngestOps, ResearchStore

logger = logging.getLogger(__name__)


class AnalysisOps:
    """Data analysis operations that auto-ingest to ResearchStore."""

    def __init__(self, workspace_dir: Path, research_store: ResearchStore):
        self.workspace_dir = workspace_dir
        self.ingest = IngestOps(research_store)

    def _load_csv(self, filename: str) -> pd.DataFrame:
        """Load CSV from workspace directory."""
        path = self.workspace_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"File not found: {filename}")
        return pd.read_csv(path)

    def _safe_path(self, filename: str) -> Path:
        """Validate filename is within workspace."""
        path = (self.workspace_dir / filename).resolve()
        if not str(path).startswith(str(self.workspace_dir.resolve())):
            raise ValueError(f"Path traversal blocked: {filename}")
        return path

    @staticmethod
    def _safe_sqrt_diag(matrix: np.ndarray, tol: float = 1e-12) -> np.ndarray:
        """Return numerically stable sqrt(diag(matrix)).

        Tiny negative values from floating-point error are clipped to zero.
        Materially negative variances are surfaced as NaN.
        """
        diag = np.asarray(np.diag(matrix), dtype=float)
        cleaned = np.where(diag < -tol, np.nan, np.clip(diag, 0.0, None))
        with np.errstate(invalid="ignore"):
            return np.sqrt(cleaned)

    def analyze_descriptives(
        self,
        filename: str,
        variables: Optional[List[str]] = None,
        by_group: Optional[str] = None,
    ) -> str:
        """Compute descriptive statistics and auto-ingest to store.

        Args:
            filename: CSV file in workspace
            variables: List of variable names (default: all numeric)
            by_group: Optional grouping variable

        Returns:
            Formatted APA table and prose
        """
        df = self._load_csv(filename)

        # Select variables
        if variables:
            missing = [v for v in variables if v not in df.columns]
            if missing:
                return f"Error: Variables not found: {missing}"
            df_subset = df[variables]
        else:
            df_subset = df.select_dtypes(include=[np.number])

        if df_subset.empty:
            return "Error: No numeric variables found"

        # Compute descriptives
        var_stats = []
        for col in df_subset.columns:
            data = df_subset[col].dropna()
            var_stats.append({
                "name": col,
                "mean": float(data.mean()),
                "sd": float(data.std()),
                "min": float(data.min()),
                "max": float(data.max()),
                "n": int(len(data)),
            })

        # Ingest to store
        self.ingest.ingest_descriptives(variables=var_stats, by_group=by_group)

        # Get the result and format it
        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_correlation(
        self,
        filename: str,
        variables: List[str],
        method: str = "pearson",
    ) -> str:
        """Compute correlation matrix and auto-ingest to store.

        Args:
            filename: CSV file in workspace
            variables: List of variable names
            method: 'pearson' or 'spearman'

        Returns:
            Formatted APA correlation table and prose
        """
        df = self._load_csv(filename)

        # Validate variables
        missing = [v for v in variables if v not in df.columns]
        if missing:
            return f"Error: Variables not found: {missing}"

        df_subset = df[variables].dropna()
        n = len(df_subset)

        if n < 3:
            return f"Error: Not enough data points (n={n}, need at least 3)"

        # Compute correlation matrix
        if method == "pearson":
            corr_matrix = df_subset.corr(method="pearson")
        else:
            corr_matrix = df_subset.corr(method="spearman")

        # Compute p-values
        p_matrix = []
        for i, var1 in enumerate(variables):
            p_row = []
            for j, var2 in enumerate(variables):
                if i == j:
                    p_row.append(None)
                else:
                    x = df_subset[var1].values
                    y = df_subset[var2].values
                    if method == "pearson":
                        _, p = stats.pearsonr(x, y)
                    else:
                        _, p = stats.spearmanr(x, y)
                    p_row.append(float(p))
            p_matrix.append(p_row)

        # Ingest to store
        self.ingest.ingest_correlation(
            variables=variables,
            matrix=corr_matrix.values.tolist(),
            p_values=p_matrix,
            n=n,
            method=method,
        )

        # Format result
        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_regression(
        self,
        filename: str,
        dependent_var: str,
        independent_vars: List[str],
        regression_type: str = "ols",
    ) -> str:
        """Run regression analysis and auto-ingest to store.

        Args:
            filename: CSV file in workspace
            dependent_var: Dependent variable name
            independent_vars: List of independent variable names
            regression_type: 'ols' (more types can be added)

        Returns:
            Formatted APA regression table and prose, plus assumption checks
        """
        df = self._load_csv(filename)

        # Validate variables
        all_vars = [dependent_var] + independent_vars
        missing = [v for v in all_vars if v not in df.columns]
        if missing:
            return f"Error: Variables not found: {missing}"

        # Drop missing values
        df_clean = df[all_vars].dropna()
        n = len(df_clean)

        if n < len(independent_vars) + 2:
            return f"Error: Not enough observations (n={n}) for {len(independent_vars)} predictors"

        # Prepare data
        y = df_clean[dependent_var].values
        X = df_clean[independent_vars].values

        # Add constant for intercept
        X_with_const = np.column_stack([np.ones(n), X])

        # OLS regression using numpy (avoiding statsmodels complexity)
        try:
            # Solve normal equations: beta = (X'X)^-1 X'y
            XtX = X_with_const.T @ X_with_const
            Xty = X_with_const.T @ y
            betas = np.linalg.solve(XtX, Xty)

            # Predictions and residuals
            y_pred = X_with_const @ betas
            residuals = y - y_pred

            # Sum of squares
            ss_res = np.sum(residuals ** 2)
            ss_tot = np.sum((y - np.mean(y)) ** 2)

            # R-squared
            r_squared = 1 - (ss_res / ss_tot)

            # Adjusted R-squared
            adj_r_squared = 1 - (1 - r_squared) * (n - 1) / (n - len(betas))

            # Standard errors
            mse = ss_res / (n - len(betas))
            var_betas = mse * np.linalg.inv(XtX)
            se_betas = self._safe_sqrt_diag(var_betas)

            # t-statistics and p-values
            t_stats = betas / se_betas
            p_values = 2 * (1 - stats.t.cdf(np.abs(t_stats), df=n - len(betas)))

            # F-statistic
            k = len(independent_vars)
            f_stat = ((ss_tot - ss_res) / k) / (ss_res / (n - k - 1))
            f_p = 1 - stats.f.cdf(f_stat, k, n - k - 1)

        except np.linalg.LinAlgError:
            return "Error: Singular matrix - check for multicollinearity"

        # Build predictors list (skip intercept at index 0)
        predictors = []
        for i, var_name in enumerate(independent_vars):
            idx = i + 1  # Skip intercept
            predictors.append({
                "name": var_name,
                "coef": float(betas[idx]),
                "se": float(se_betas[idx]),
                "t": float(t_stats[idx]),
                "p": float(p_values[idx]),
            })

        # Ingest to store
        self.ingest.ingest_regression(
            type=regression_type,
            dependent_var=dependent_var,
            predictors=predictors,
            r_squared=float(r_squared),
            adj_r_squared=float(adj_r_squared),
            f_stat=float(f_stat),
            f_p=float(f_p),
            n=n,
        )

        # Format result
        result_id = f"result_{self.ingest.store._result_counter:03d}"
        formatted = self.ingest.format_result(result_id)

        # Add assumption checks
        assumption_checks = self._check_regression_assumptions(residuals, y_pred, n, k)
        if assumption_checks:
            formatted += f"\n\n---\n\n**Assumption Checks:**\n{assumption_checks}"

        return formatted

    def _check_regression_assumptions(
        self,
        residuals: np.ndarray,
        y_pred: np.ndarray,
        n: int,
        k: int,
    ) -> str:
        """Run basic regression assumption checks."""
        checks = []

        # 1. Normality of residuals (Shapiro-Wilk, use sample if n > 5000)
        if n <= 5000:
            _, p_shapiro = stats.shapiro(residuals)
            if p_shapiro < 0.05:
                checks.append(f"- Normality: Shapiro-Wilk p = {p_shapiro:.3f} (residuals may not be normal)")
            else:
                checks.append(f"- Normality: Shapiro-Wilk p = {p_shapiro:.3f} (OK)")
        else:
            sample = np.random.choice(residuals, 5000, replace=False)
            _, p_shapiro = stats.shapiro(sample)
            checks.append(f"- Normality: Shapiro-Wilk p = {p_shapiro:.3f} (sampled n=5000)")

        # 2. Homoscedasticity - simple check via correlation of |residuals| with predictions
        _, p_homo = stats.pearsonr(np.abs(residuals), y_pred)
        if p_homo < 0.05:
            checks.append(f"- Homoscedasticity: Warning - residual magnitude correlates with predictions (p = {p_homo:.3f})")
        else:
            checks.append(f"- Homoscedasticity: OK (p = {p_homo:.3f})")

        # 3. Residual mean should be ~0
        mean_res = np.mean(residuals)
        checks.append(f"- Residual mean: {mean_res:.6f} (should be ~0)")

        return "\n".join(checks)

    def analyze_ttest(
        self,
        filename: str,
        variable: str,
        group_var: str,
        test_type: str = "independent",
    ) -> str:
        """Run t-test and auto-ingest to store.

        Args:
            filename: CSV file in workspace
            variable: Numeric variable to compare
            group_var: Grouping variable (must have exactly 2 groups)
            test_type: 'independent' or 'paired'

        Returns:
            Formatted APA t-test result
        """
        df = self._load_csv(filename)

        # Validate variables
        if variable not in df.columns:
            return f"Error: Variable not found: {variable}"
        if group_var not in df.columns:
            return f"Error: Group variable not found: {group_var}"

        # Get groups
        groups = df[group_var].dropna().unique()
        if len(groups) != 2:
            return f"Error: Expected 2 groups, found {len(groups)}: {list(groups)}"

        group1_name, group2_name = str(groups[0]), str(groups[1])
        group1_data = df[df[group_var] == groups[0]][variable].dropna()
        group2_data = df[df[group_var] == groups[1]][variable].dropna()

        if len(group1_data) < 2 or len(group2_data) < 2:
            return "Error: Each group needs at least 2 observations"

        # Run t-test
        if test_type == "independent":
            t_stat, p_value = stats.ttest_ind(group1_data, group2_data)
            df_val = len(group1_data) + len(group2_data) - 2
        else:
            if len(group1_data) != len(group2_data):
                return "Error: Paired t-test requires equal group sizes"
            t_stat, p_value = stats.ttest_rel(group1_data, group2_data)
            df_val = len(group1_data) - 1

        # Compute effect size (Cohen's d)
        pooled_std = np.sqrt(
            ((len(group1_data) - 1) * group1_data.std() ** 2 +
             (len(group2_data) - 1) * group2_data.std() ** 2) /
            (len(group1_data) + len(group2_data) - 2)
        )
        cohens_d = (group1_data.mean() - group2_data.mean()) / pooled_std

        # Ingest to store
        self.ingest.ingest_ttest(
            type=test_type,
            group1=group1_name,
            group2=group2_name,
            mean1=float(group1_data.mean()),
            mean2=float(group2_data.mean()),
            sd1=float(group1_data.std()),
            sd2=float(group2_data.std()),
            t=float(t_stat),
            df=float(df_val),
            p=float(p_value),
            cohens_d=float(cohens_d),
        )

        # Format result
        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_anova(
        self,
        filename: str,
        variable: str,
        group_var: str,
        post_hoc: bool = True,
    ) -> str:
        """Run one-way ANOVA and auto-ingest to store.

        Args:
            filename: CSV file in workspace
            variable: Numeric dependent variable
            group_var: Categorical grouping variable (3+ groups)
            post_hoc: Whether to run Tukey HSD post-hoc tests

        Returns:
            Formatted APA ANOVA result with post-hoc if requested
        """
        df = self._load_csv(filename)

        # Validate variables
        if variable not in df.columns:
            return f"Error: Variable not found: {variable}"
        if group_var not in df.columns:
            return f"Error: Group variable not found: {group_var}"

        # Get groups
        groups = df[group_var].dropna().unique()
        if len(groups) < 2:
            return f"Error: Need at least 2 groups, found {len(groups)}"

        # Prepare group data
        group_data = []
        group_stats = []
        for g in groups:
            data = df[df[group_var] == g][variable].dropna()
            if len(data) < 2:
                return f"Error: Group '{g}' has fewer than 2 observations"
            group_data.append(data.values)
            group_stats.append({
                "name": str(g),
                "mean": float(data.mean()),
                "sd": float(data.std()),
                "n": len(data),
            })

        # Run ANOVA
        f_stat, p_value = stats.f_oneway(*group_data)

        # Calculate degrees of freedom
        k = len(groups)
        n_total = sum(len(g) for g in group_data)
        df_between = k - 1
        df_within = n_total - k

        # Calculate eta-squared (SS_between / SS_total)
        grand_mean = np.concatenate(group_data).mean()
        ss_between = sum(len(g) * (g.mean() - grand_mean) ** 2 for g in group_data)
        ss_total = sum(((g - grand_mean) ** 2).sum() for g in group_data)
        eta_squared = float(ss_between / ss_total) if ss_total > 0 else 0.0

        # Post-hoc tests (Tukey HSD approximation using pairwise t-tests with Bonferroni)
        post_hoc_results = None
        if post_hoc and p_value < 0.05 and len(groups) >= 3:
            post_hoc_results = []
            n_comparisons = k * (k - 1) // 2
            for i in range(len(groups)):
                for j in range(i + 1, len(groups)):
                    g1, g2 = group_data[i], group_data[j]
                    t_stat, p_pair = stats.ttest_ind(g1, g2)
                    p_adjusted = min(p_pair * n_comparisons, 1.0)  # Bonferroni
                    post_hoc_results.append({
                        "group1": str(groups[i]),
                        "group2": str(groups[j]),
                        "diff": float(g1.mean() - g2.mean()),
                        "p": float(p_adjusted),
                        "significant": p_adjusted < 0.05,
                    })

        # Ingest to store
        self.ingest.ingest_anova(
            dependent_var=variable,
            group_var=group_var,
            groups=group_stats,
            f_stat=float(f_stat),
            df_between=df_between,
            df_within=df_within,
            p=float(p_value),
            eta_squared=eta_squared,
            post_hoc=post_hoc_results,
        )

        # Format result
        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_chisquare(
        self,
        filename: str,
        var1: str,
        var2: str,
    ) -> str:
        """Run chi-square test of independence and auto-ingest to store.

        Args:
            filename: CSV file in workspace
            var1: First categorical variable (rows)
            var2: Second categorical variable (columns)

        Returns:
            Formatted APA chi-square result with contingency table
        """
        df = self._load_csv(filename)

        # Validate variables
        if var1 not in df.columns:
            return f"Error: Variable not found: {var1}"
        if var2 not in df.columns:
            return f"Error: Variable not found: {var2}"

        # Create contingency table
        contingency = pd.crosstab(df[var1], df[var2])
        row_labels = [str(x) for x in contingency.index.tolist()]
        col_labels = [str(x) for x in contingency.columns.tolist()]
        table = contingency.values.tolist()

        # Run chi-square test
        chi2, p_value, dof, expected = stats.chi2_contingency(contingency)

        # Calculate Cramer's V
        n = contingency.sum().sum()
        min_dim = min(len(row_labels) - 1, len(col_labels) - 1)
        cramers_v = float(np.sqrt(chi2 / (n * min_dim))) if min_dim > 0 else 0.0

        # Ingest to store
        self.ingest.ingest_chisquare(
            var1=var1,
            var2=var2,
            contingency_table=table,
            row_labels=row_labels,
            col_labels=col_labels,
            chi_square=float(chi2),
            df=int(dof),
            p=float(p_value),
            n=int(n),
            cramers_v=cramers_v,
        )

        # Format result
        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def list_csv_columns(self, filename: str) -> str:
        """List columns in a CSV file with their types.

        Args:
            filename: CSV file in workspace

        Returns:
            Summary of columns
        """
        df = self._load_csv(filename)

        lines = [f"Columns in {filename} (n={len(df)} rows):"]
        for col in df.columns:
            n_missing = df[col].isna().sum()
            # Use pandas api for dtype checking (handles StringDtype, etc.)
            if pd.api.types.is_numeric_dtype(df[col]):
                lines.append(f"  - {col}: numeric ({n_missing} missing)")
            else:
                n_unique = df[col].nunique()
                lines.append(f"  - {col}: categorical ({n_unique} unique, {n_missing} missing)")

        return "\n".join(lines)

    # =========================================================================
    # PHASE 2b: EXTENDED ANALYSIS FUNCTIONS
    # =========================================================================

    def analyze_logistic_regression(
        self,
        filename: str,
        dependent_var: str,
        independent_vars: List[str],
    ) -> str:
        """Run logistic regression for binary outcomes.

        Args:
            filename: CSV file in workspace
            dependent_var: Binary dependent variable (0/1)
            independent_vars: List of predictor variable names

        Returns:
            Formatted APA logistic regression results with odds ratios
        """
        df = self._load_csv(filename)

        # Validate variables
        all_vars = [dependent_var] + independent_vars
        missing = [v for v in all_vars if v not in df.columns]
        if missing:
            return f"Error: Variables not found: {missing}"

        # Drop missing values
        df_clean = df[all_vars].dropna()
        n = len(df_clean)

        if n < len(independent_vars) + 10:
            return f"Error: Not enough observations (n={n}) for {len(independent_vars)} predictors"

        y = df_clean[dependent_var].values
        unique_y = np.unique(y)
        if len(unique_y) != 2:
            return f"Error: Dependent variable must be binary (found {len(unique_y)} unique values)"

        # Ensure y is 0/1
        if set(unique_y) != {0, 1}:
            y = (y == unique_y[1]).astype(int)

        n_events = int(y.sum())
        X = df_clean[independent_vars].values

        # Logistic regression using scipy.optimize
        from scipy.optimize import minimize

        def neg_log_likelihood(beta, X, y):
            """Negative log-likelihood for logistic regression."""
            X_with_const = np.column_stack([np.ones(len(X)), X])
            z = X_with_const @ beta
            # Clip to prevent overflow
            z = np.clip(z, -500, 500)
            p = 1 / (1 + np.exp(-z))
            p = np.clip(p, 1e-10, 1 - 1e-10)
            return -np.sum(y * np.log(p) + (1 - y) * np.log(1 - p))

        # Initial values
        n_params = len(independent_vars) + 1
        beta_init = np.zeros(n_params)

        try:
            result = minimize(neg_log_likelihood, beta_init, args=(X, y), method='BFGS')
            betas = result.x

            # Compute Hessian for standard errors
            from scipy.optimize import approx_fprime
            eps = 1e-5
            hessian = np.zeros((n_params, n_params))
            for i in range(n_params):
                def grad_i(beta):
                    grad = approx_fprime(beta, neg_log_likelihood, eps, X, y)
                    return grad[i]
                hessian[i] = approx_fprime(betas, grad_i, eps)

            try:
                cov = np.linalg.inv(hessian)
                se_betas = self._safe_sqrt_diag(cov)
            except np.linalg.LinAlgError:
                se_betas = np.full(n_params, np.nan)

            # Z-statistics and p-values
            with np.errstate(divide="ignore", invalid="ignore"):
                z_stats = betas / se_betas
            p_values = 2 * (1 - stats.norm.cdf(np.abs(z_stats)))

            # Odds ratios and confidence intervals
            odds_ratios = np.exp(betas)
            ci_lower = np.exp(betas - 1.96 * se_betas)
            ci_upper = np.exp(betas + 1.96 * se_betas)

            # Model fit statistics
            ll_model = -neg_log_likelihood(betas, X, y)
            ll_null = -neg_log_likelihood(np.zeros(n_params), X, y)
            pseudo_r2 = 1 - (ll_model / ll_null)
            chi_square = -2 * (ll_null - ll_model)
            chi_p = 1 - stats.chi2.cdf(chi_square, len(independent_vars))
            aic = 2 * n_params - 2 * ll_model

        except Exception as e:
            return f"Error: Logistic regression failed - {str(e)}"

        # Build predictors list (skip intercept at index 0)
        predictors = []
        for i, var_name in enumerate(independent_vars):
            idx = i + 1
            predictors.append({
                "name": var_name,
                "coef": float(betas[idx]),
                "se": float(se_betas[idx]) if not np.isnan(se_betas[idx]) else None,
                "z": float(z_stats[idx]) if not np.isnan(z_stats[idx]) else None,
                "p": float(p_values[idx]) if not np.isnan(p_values[idx]) else None,
                "odds_ratio": float(odds_ratios[idx]),
                "ci_lower": float(ci_lower[idx]) if not np.isnan(ci_lower[idx]) else None,
                "ci_upper": float(ci_upper[idx]) if not np.isnan(ci_upper[idx]) else None,
            })

        # Ingest to store
        self.ingest.ingest_logistic_regression(
            dependent_var=dependent_var,
            predictors=predictors,
            n=n,
            n_events=n_events,
            pseudo_r_squared=float(pseudo_r2),
            log_likelihood=float(ll_model),
            aic=float(aic),
            chi_square=float(chi_square),
            chi_p=float(chi_p),
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_mann_whitney(
        self,
        filename: str,
        variable: str,
        group_var: str,
    ) -> str:
        """Run Mann-Whitney U test (non-parametric alternative to t-test).

        Args:
            filename: CSV file in workspace
            variable: Numeric variable to compare
            group_var: Grouping variable (must have exactly 2 groups)

        Returns:
            Formatted APA Mann-Whitney U test results
        """
        df = self._load_csv(filename)

        if variable not in df.columns:
            return f"Error: Variable not found: {variable}"
        if group_var not in df.columns:
            return f"Error: Group variable not found: {group_var}"

        groups = df[group_var].dropna().unique()
        if len(groups) != 2:
            return f"Error: Expected 2 groups, found {len(groups)}"

        g1_data = df[df[group_var] == groups[0]][variable].dropna()
        g2_data = df[df[group_var] == groups[1]][variable].dropna()

        if len(g1_data) < 2 or len(g2_data) < 2:
            return "Error: Each group needs at least 2 observations"

        # Run Mann-Whitney U
        u_stat, p_value = stats.mannwhitneyu(g1_data, g2_data, alternative='two-sided')

        # Effect size r = Z / sqrt(N)
        n_total = len(g1_data) + len(g2_data)
        z = stats.norm.ppf(1 - p_value / 2) if p_value < 1 else 0
        r_effect = z / np.sqrt(n_total)

        # Calculate mean ranks
        combined = pd.concat([
            pd.DataFrame({'value': g1_data, 'group': str(groups[0])}),
            pd.DataFrame({'value': g2_data, 'group': str(groups[1])})
        ])
        combined['rank'] = combined['value'].rank()
        mean_ranks = combined.groupby('group')['rank'].mean()

        group_stats = [
            {
                "name": str(groups[0]),
                "n": len(g1_data),
                "median": float(g1_data.median()),
                "mean_rank": float(mean_ranks[str(groups[0])]),
            },
            {
                "name": str(groups[1]),
                "n": len(g2_data),
                "median": float(g2_data.median()),
                "mean_rank": float(mean_ranks[str(groups[1])]),
            },
        ]

        self.ingest.ingest_nonparametric(
            test_type="mann_whitney",
            variable=variable,
            statistic=float(u_stat),
            p=float(p_value),
            n=n_total,
            groups=group_stats,
            effect_size=float(r_effect),
            effect_name="r",
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_kruskal_wallis(
        self,
        filename: str,
        variable: str,
        group_var: str,
    ) -> str:
        """Run Kruskal-Wallis H test (non-parametric alternative to one-way ANOVA).

        Args:
            filename: CSV file in workspace
            variable: Numeric variable to compare
            group_var: Grouping variable (3+ groups)

        Returns:
            Formatted APA Kruskal-Wallis H test results
        """
        df = self._load_csv(filename)

        if variable not in df.columns:
            return f"Error: Variable not found: {variable}"
        if group_var not in df.columns:
            return f"Error: Group variable not found: {group_var}"

        groups = df[group_var].dropna().unique()
        if len(groups) < 2:
            return f"Error: Need at least 2 groups, found {len(groups)}"

        group_data = []
        group_stats = []
        for g in groups:
            data = df[df[group_var] == g][variable].dropna()
            if len(data) < 2:
                return f"Error: Group '{g}' has fewer than 2 observations"
            group_data.append(data.values)

        # Run Kruskal-Wallis
        h_stat, p_value = stats.kruskal(*group_data)

        # Effect size epsilon-squared = H / (N-1)
        n_total = sum(len(g) for g in group_data)
        epsilon_sq = h_stat / (n_total - 1)

        # Calculate mean ranks
        all_data = []
        for i, g in enumerate(groups):
            data = df[df[group_var] == g][variable].dropna()
            for v in data:
                all_data.append({'value': v, 'group': str(g)})
        combined = pd.DataFrame(all_data)
        combined['rank'] = combined['value'].rank()
        mean_ranks = combined.groupby('group')['rank'].mean()

        for g in groups:
            data = df[df[group_var] == g][variable].dropna()
            group_stats.append({
                "name": str(g),
                "n": len(data),
                "median": float(data.median()),
                "mean_rank": float(mean_ranks[str(g)]),
            })

        self.ingest.ingest_nonparametric(
            test_type="kruskal_wallis",
            variable=variable,
            statistic=float(h_stat),
            p=float(p_value),
            n=n_total,
            groups=group_stats,
            effect_size=float(epsilon_sq),
            effect_name="ε²",
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_wilcoxon(
        self,
        filename: str,
        var1: str,
        var2: str,
    ) -> str:
        """Run Wilcoxon signed-rank test (non-parametric alternative to paired t-test).

        Args:
            filename: CSV file in workspace
            var1: First measurement variable
            var2: Second measurement variable (paired with var1)

        Returns:
            Formatted APA Wilcoxon signed-rank test results
        """
        df = self._load_csv(filename)

        if var1 not in df.columns:
            return f"Error: Variable not found: {var1}"
        if var2 not in df.columns:
            return f"Error: Variable not found: {var2}"

        # Get paired data
        df_clean = df[[var1, var2]].dropna()
        n = len(df_clean)

        if n < 6:
            return f"Error: Need at least 6 paired observations, found {n}"

        x = df_clean[var1].values
        y = df_clean[var2].values

        # Run Wilcoxon signed-rank test
        w_stat, p_value = stats.wilcoxon(x, y)

        # Effect size r = Z / sqrt(N)
        z = stats.norm.ppf(1 - p_value / 2) if p_value < 1 else 0
        r_effect = z / np.sqrt(n)

        group_stats = [
            {"name": var1, "n": n, "median": float(np.median(x)), "mean_rank": None},
            {"name": var2, "n": n, "median": float(np.median(y)), "mean_rank": None},
        ]

        self.ingest.ingest_nonparametric(
            test_type="wilcoxon",
            variable=f"{var1} vs {var2}",
            statistic=float(w_stat),
            p=float(p_value),
            n=n,
            groups=group_stats,
            effect_size=float(r_effect),
            effect_name="r",
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_factorial_anova(
        self,
        filename: str,
        variable: str,
        factor1: str,
        factor2: str,
    ) -> str:
        """Run two-way (factorial) ANOVA with interaction.

        Args:
            filename: CSV file in workspace
            variable: Numeric dependent variable
            factor1: First categorical factor
            factor2: Second categorical factor

        Returns:
            Formatted APA factorial ANOVA results
        """
        df = self._load_csv(filename)

        for v in [variable, factor1, factor2]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        df_clean = df[[variable, factor1, factor2]].dropna()
        n = len(df_clean)

        if n < 20:
            return f"Error: Need at least 20 observations for factorial ANOVA, found {n}"

        factor1_levels = [str(x) for x in df_clean[factor1].unique()]
        factor2_levels = [str(x) for x in df_clean[factor2].unique()]

        if len(factor1_levels) < 2 or len(factor2_levels) < 2:
            return "Error: Each factor needs at least 2 levels"

        # Calculate cell means
        cell_means = []
        for f1 in factor1_levels:
            row = []
            for f2 in factor2_levels:
                cell = df_clean[(df_clean[factor1].astype(str) == f1) & (df_clean[factor2].astype(str) == f2)][variable]
                row.append({"mean": float(cell.mean()) if len(cell) > 0 else 0,
                           "sd": float(cell.std()) if len(cell) > 1 else 0,
                           "n": len(cell)})
            cell_means.append(row)

        # Calculate sums of squares (Type III approximation)
        grand_mean = df_clean[variable].mean()
        ss_total = ((df_clean[variable] - grand_mean) ** 2).sum()

        # Main effect 1
        f1_means = df_clean.groupby(factor1)[variable].mean()
        f1_ns = df_clean.groupby(factor1)[variable].count()
        ss_f1 = sum(f1_ns[g] * (f1_means[g] - grand_mean) ** 2 for g in f1_means.index)

        # Main effect 2
        f2_means = df_clean.groupby(factor2)[variable].mean()
        f2_ns = df_clean.groupby(factor2)[variable].count()
        ss_f2 = sum(f2_ns[g] * (f2_means[g] - grand_mean) ** 2 for g in f2_means.index)

        # Interaction and error
        grouped = df_clean.groupby([factor1, factor2])[variable]
        cell_ms = grouped.mean()
        cell_ns = grouped.count()

        ss_cells = sum(cell_ns[g] * (cell_ms[g] - grand_mean) ** 2 for g in cell_ms.index)
        ss_interaction = ss_cells - ss_f1 - ss_f2
        ss_error = ss_total - ss_cells

        # Degrees of freedom
        df_f1 = len(factor1_levels) - 1
        df_f2 = len(factor2_levels) - 1
        df_interaction = df_f1 * df_f2
        df_error = n - len(factor1_levels) * len(factor2_levels)

        if df_error <= 0:
            return "Error: Not enough observations per cell for factorial ANOVA"

        # Mean squares and F-statistics
        ms_f1 = ss_f1 / df_f1
        ms_f2 = ss_f2 / df_f2
        ms_interaction = ss_interaction / df_interaction if df_interaction > 0 else 0
        ms_error = ss_error / df_error

        f_f1 = ms_f1 / ms_error if ms_error > 0 else 0
        f_f2 = ms_f2 / ms_error if ms_error > 0 else 0
        f_interaction = ms_interaction / ms_error if ms_error > 0 else 0

        p_f1 = 1 - stats.f.cdf(f_f1, df_f1, df_error)
        p_f2 = 1 - stats.f.cdf(f_f2, df_f2, df_error)
        p_interaction = 1 - stats.f.cdf(f_interaction, df_interaction, df_error)

        # Partial eta-squared
        eta_f1 = ss_f1 / (ss_f1 + ss_error)
        eta_f2 = ss_f2 / (ss_f2 + ss_error)
        eta_interaction = ss_interaction / (ss_interaction + ss_error)

        self.ingest.ingest_factorial_anova(
            dependent_var=variable,
            factor1=factor1,
            factor2=factor2,
            factor1_levels=factor1_levels,
            factor2_levels=factor2_levels,
            main_effect1={"f_stat": float(f_f1), "df": df_f1, "p": float(p_f1), "eta_squared": float(eta_f1)},
            main_effect2={"f_stat": float(f_f2), "df": df_f2, "p": float(p_f2), "eta_squared": float(eta_f2)},
            interaction={"f_stat": float(f_interaction), "df": df_interaction, "p": float(p_interaction), "eta_squared": float(eta_interaction)},
            cell_means=cell_means,
            n=n,
            df_error=df_error,
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_repeated_measures(
        self,
        filename: str,
        subject_var: str,
        within_var: str,
        value_var: str,
    ) -> str:
        """Run repeated measures ANOVA (within-subjects design).

        Args:
            filename: CSV file in workspace (long format)
            subject_var: Subject/participant ID variable
            within_var: Within-subjects factor variable
            value_var: Dependent variable (measurement)

        Returns:
            Formatted APA repeated measures ANOVA results
        """
        df = self._load_csv(filename)

        for v in [subject_var, within_var, value_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        df_clean = df[[subject_var, within_var, value_var]].dropna()
        levels = [str(x) for x in df_clean[within_var].unique()]
        n_levels = len(levels)

        if n_levels < 2:
            return "Error: Need at least 2 levels for repeated measures"

        subjects = df_clean[subject_var].unique()
        n_subjects = len(subjects)

        if n_subjects < 5:
            return f"Error: Need at least 5 subjects, found {n_subjects}"

        # Check complete data
        for subj in subjects:
            subj_data = df_clean[df_clean[subject_var] == subj]
            if len(subj_data[within_var].unique()) != n_levels:
                return f"Error: Subject {subj} does not have data for all {n_levels} levels"

        # Calculate level means
        level_means = []
        level_data = []
        for level in levels:
            data = df_clean[df_clean[within_var].astype(str) == level][value_var]
            level_means.append({
                "name": level,
                "mean": float(data.mean()),
                "sd": float(data.std()),
                "n": n_subjects,
            })
            level_data.append(data.values)

        # Calculate F-statistic for repeated measures
        grand_mean = df_clean[value_var].mean()

        # SS treatment (between levels)
        ss_treatment = n_subjects * sum((df_clean[df_clean[within_var].astype(str) == lv][value_var].mean() - grand_mean) ** 2
                                        for lv in levels)

        # SS subjects
        subject_means = df_clean.groupby(subject_var)[value_var].mean()
        ss_subjects = n_levels * sum((subject_means[s] - grand_mean) ** 2 for s in subjects)

        # SS total and SS error
        ss_total = ((df_clean[value_var] - grand_mean) ** 2).sum()
        ss_error = ss_total - ss_treatment - ss_subjects

        # Degrees of freedom
        df_treatment = n_levels - 1
        df_subjects = n_subjects - 1
        df_error = df_treatment * df_subjects

        # F-statistic
        ms_treatment = ss_treatment / df_treatment
        ms_error = ss_error / df_error if df_error > 0 else 1
        f_stat = ms_treatment / ms_error
        p_value = 1 - stats.f.cdf(f_stat, df_treatment, df_error)

        # Partial eta-squared
        eta_squared = ss_treatment / (ss_treatment + ss_error)

        # Check sphericity (simplified - Mauchly's test approximation)
        # For simplicity, assume sphericity is OK if variance ratios are similar
        variances = [np.var(d) for d in level_data]
        var_ratio = max(variances) / min(variances) if min(variances) > 0 else float('inf')
        sphericity_violated = var_ratio > 3.0

        # Greenhouse-Geisser epsilon (simplified estimate)
        epsilon = 1.0
        if sphericity_violated:
            epsilon = max(0.5, 1.0 / (n_levels - 1))  # Lower bound approximation

        # Correct df if sphericity violated
        df_effect = df_treatment * epsilon if sphericity_violated else float(df_treatment)
        df_error_corrected = df_error * epsilon if sphericity_violated else float(df_error)

        self.ingest.ingest_repeated_measures(
            dependent_var=value_var,
            within_factor=within_var,
            levels=levels,
            level_means=level_means,
            f_stat=float(f_stat),
            df_effect=df_effect,
            df_error=df_error_corrected,
            p=float(p_value),
            n=n_subjects,
            eta_squared=float(eta_squared),
            sphericity_violated=sphericity_violated,
            epsilon=float(epsilon) if sphericity_violated else None,
            mauchly_p=0.01 if sphericity_violated else None,
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_reliability(
        self,
        filename: str,
        items: List[str],
        scale_name: str = "Scale",
    ) -> str:
        """Calculate Cronbach's alpha for scale reliability.

        Args:
            filename: CSV file in workspace
            items: List of item variable names (must be numeric)
            scale_name: Name of the scale for reporting

        Returns:
            Formatted APA reliability analysis results
        """
        df = self._load_csv(filename)

        missing = [v for v in items if v not in df.columns]
        if missing:
            return f"Error: Variables not found: {missing}"

        df_items = df[items].dropna()
        n_cases = len(df_items)
        n_items = len(items)

        if n_cases < 10:
            return f"Error: Need at least 10 cases, found {n_cases}"
        if n_items < 2:
            return f"Error: Need at least 2 items, found {n_items}"

        # Calculate Cronbach's alpha
        item_variances = df_items.var(ddof=1)
        total_scores = df_items.sum(axis=1)
        total_variance = total_scores.var(ddof=1)

        sum_item_variances = item_variances.sum()
        cronbachs_alpha = (n_items / (n_items - 1)) * (1 - sum_item_variances / total_variance)

        # Mean inter-item correlation
        corr_matrix = df_items.corr()
        n_pairs = n_items * (n_items - 1) / 2
        mean_inter_item_r = (corr_matrix.sum().sum() - n_items) / (2 * n_pairs)

        # Item statistics
        item_stats = []
        for item in items:
            # Item-total correlation (corrected)
            other_items = [i for i in items if i != item]
            other_total = df_items[other_items].sum(axis=1)
            item_total_r = df_items[item].corr(other_total)

            # Alpha if item deleted
            if len(other_items) >= 2:
                other_df = df_items[other_items]
                other_var = other_df.var(ddof=1).sum()
                other_total_var = other_df.sum(axis=1).var(ddof=1)
                alpha_if_deleted = ((n_items - 1) / (n_items - 2)) * (1 - other_var / other_total_var)
            else:
                alpha_if_deleted = 0

            item_stats.append({
                "name": item,
                "item_total_r": float(item_total_r),
                "alpha_if_deleted": float(alpha_if_deleted),
            })

        self.ingest.ingest_reliability(
            scale_name=scale_name,
            items=items,
            cronbachs_alpha=float(cronbachs_alpha),
            n_items=n_items,
            n_cases=n_cases,
            item_stats=item_stats,
            mean_inter_item_r=float(mean_inter_item_r),
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    # =========================================================================
    # PHASE 3: ADVANCED ANALYSIS
    # =========================================================================

    def analyze_mixed_model(
        self,
        filename: str,
        dependent_var: str,
        fixed_vars: List[str],
        group_var: str,
    ) -> str:
        """Run a mixed-effects (multilevel) model.

        Args:
            filename: CSV file in workspace
            dependent_var: Numeric dependent variable
            fixed_vars: List of fixed effect predictors
            group_var: Grouping variable for random intercept

        Returns:
            Formatted APA mixed model results
        """
        df = self._load_csv(filename)

        all_vars = [dependent_var] + fixed_vars + [group_var]
        for v in all_vars:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        df_clean = df[all_vars].dropna()
        n_obs = len(df_clean)
        groups = df_clean[group_var].unique()
        n_groups = len(groups)

        if n_obs < 30:
            return f"Error: Need at least 30 observations for mixed models, found {n_obs}"
        if n_groups < 3:
            return f"Error: Need at least 3 groups, found {n_groups}"

        try:
            import statsmodels.formula.api as smf
            from statsmodels.tools.sm_exceptions import ConvergenceWarning

            # Build formula
            formula = f"{dependent_var} ~ " + " + ".join(fixed_vars)

            # Fit mixed model with random intercept
            model = smf.mixedlm(formula, df_clean, groups=df_clean[group_var])
            with warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter("always", ConvergenceWarning)
                result = model.fit(reml=True)
            for warn in captured:
                logger.info("Mixed model convergence warning: %s", warn.message)

            # Extract fixed effects
            fixed_effects = []
            for name in result.fe_params.index:
                coef = result.fe_params[name]
                se = result.bse_fe[name] if name in result.bse_fe.index else None
                z = result.tvalues[name] if name in result.tvalues.index else None
                p = result.pvalues[name] if name in result.pvalues.index else None
                ci = result.conf_int().loc[name] if name in result.conf_int().index else [None, None]

                fixed_effects.append({
                    "name": name,
                    "coef": float(coef),
                    "se": float(se) if se else None,
                    "z": float(z) if z else None,
                    "p": float(p) if p else None,
                    "ci_lower": float(ci[0]) if ci[0] is not None else None,
                    "ci_upper": float(ci[1]) if ci[1] is not None else None,
                })

            # Extract random effects
            random_variance = result.cov_re.iloc[0, 0] if hasattr(result, 'cov_re') else result.scale
            random_effects = [{
                "group": f"{group_var} (Intercept)",
                "variance": float(random_variance),
                "sd": float(np.sqrt(max(0.0, random_variance))),
            }]

            # Add residual variance
            residual_var = result.scale
            random_effects.append({
                "group": "Residual",
                "variance": float(residual_var),
                "sd": float(np.sqrt(max(0.0, residual_var))),
            })

            # Calculate ICC
            icc = random_variance / (random_variance + residual_var)

            self.ingest.ingest_mixed_model(
                dependent_var=dependent_var,
                fixed_effects=fixed_effects,
                random_effects=random_effects,
                group_var=group_var,
                n_obs=n_obs,
                n_groups=n_groups,
                log_likelihood=float(result.llf) if hasattr(result, 'llf') else None,
                aic=float(result.aic) if hasattr(result, 'aic') else None,
                bic=float(result.bic) if hasattr(result, 'bic') else None,
                icc=float(icc),
            )

            result_id = f"result_{self.ingest.store._result_counter:03d}"
            return self.ingest.format_result(result_id)

        except ImportError:
            return "Error: statsmodels not installed. Install with: pip install statsmodels"
        except Exception as e:
            return f"Error fitting mixed model: {str(e)}"

    def analyze_manova(
        self,
        filename: str,
        dependent_vars: List[str],
        group_var: str,
    ) -> str:
        """Run a one-way MANOVA (multivariate ANOVA).

        Args:
            filename: CSV file in workspace
            dependent_vars: List of numeric dependent variables (2+)
            group_var: Grouping variable

        Returns:
            Formatted APA MANOVA results
        """
        df = self._load_csv(filename)

        all_vars = dependent_vars + [group_var]
        for v in all_vars:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        if len(dependent_vars) < 2:
            return "Error: MANOVA requires at least 2 dependent variables"

        df_clean = df[all_vars].dropna()
        n = len(df_clean)
        groups = [str(g) for g in df_clean[group_var].unique()]
        n_groups = len(groups)

        if n < 30:
            return f"Error: Need at least 30 observations, found {n}"
        if n_groups < 2:
            return f"Error: Need at least 2 groups, found {n_groups}"

        # Get Y matrix (dependent variables)
        Y = df_clean[dependent_vars].values
        p = len(dependent_vars)  # number of DVs
        k = n_groups  # number of groups

        # Calculate group means and overall mean
        overall_mean = Y.mean(axis=0)
        group_means = {}
        group_n = {}
        for g in groups:
            mask = df_clean[group_var].astype(str) == g
            group_means[g] = Y[mask].mean(axis=0)
            group_n[g] = mask.sum()

        # Calculate SSCP matrices
        # Between-groups SSCP
        B = np.zeros((p, p))
        for g in groups:
            diff = (group_means[g] - overall_mean).reshape(-1, 1)
            B += group_n[g] * diff @ diff.T

        # Within-groups (error) SSCP
        W = np.zeros((p, p))
        for g in groups:
            mask = df_clean[group_var].astype(str) == g
            Y_g = Y[mask]
            for row in Y_g:
                diff = (row - group_means[g]).reshape(-1, 1)
                W += diff @ diff.T

        # Total SSCP
        T = B + W

        # Calculate multivariate statistics
        # Wilks' Lambda
        try:
            W_inv = np.linalg.inv(W)
            eigenvalues = np.linalg.eigvals(B @ W_inv)
            eigenvalues = np.real(eigenvalues)
            eigenvalues = eigenvalues[eigenvalues > 0]
        except np.linalg.LinAlgError:
            return "Error: Cannot compute MANOVA - singular matrix"

        wilks = np.linalg.det(W) / np.linalg.det(T) if np.linalg.det(T) != 0 else 1.0

        # Pillai's Trace
        pillais = sum(e / (1 + e) for e in eigenvalues if e > 0)

        # Approximate F-test for Wilks' Lambda
        s = min(p, k - 1)
        m = (abs(p - (k - 1)) - 1) / 2
        n_prime = (n - k - p) / 2

        if s == 1:
            f_stat = ((1 - wilks) / wilks) * (n - k - p + 1) / p
            df1 = p
            df2 = n - k - p + 1
        else:
            lambda_power = wilks ** (1.0 / s)
            f_stat = ((1 - lambda_power) / lambda_power) * ((n - k - p + 1) * s - p * (k - 1) / 2 + 1) / (p * (k - 1))
            df1 = p * (k - 1)
            df2 = s * (n_prime - m) - p * (k - 1) / 2 + 1

        df1 = max(1, int(df1))
        df2 = max(1, int(df2))
        p_value = 1 - stats.f.cdf(f_stat, df1, df2)

        # Univariate ANOVAs
        univariate_results = []
        df_between = k - 1
        df_within = n - k

        for i, dv in enumerate(dependent_vars):
            ss_between = B[i, i]
            ss_within = W[i, i]
            ms_between = ss_between / df_between
            ms_within = ss_within / df_within
            f_uv = ms_between / ms_within if ms_within > 0 else 0
            p_uv = 1 - stats.f.cdf(f_uv, df_between, df_within)
            eta_sq = ss_between / (ss_between + ss_within)

            univariate_results.append({
                "dv": dv,
                "f_stat": float(f_uv),
                "df1": df_between,
                "df2": df_within,
                "p": float(p_uv),
                "eta_squared": float(eta_sq),
            })

        self.ingest.ingest_manova(
            dependent_vars=dependent_vars,
            group_var=group_var,
            groups=groups,
            pillais_trace=float(pillais),
            wilks_lambda=float(wilks),
            f_stat=float(f_stat),
            df1=df1,
            df2=df2,
            p=float(p_value),
            n=n,
            univariate_results=univariate_results,
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_mediation(
        self,
        filename: str,
        x_var: str,
        m_var: str,
        y_var: str,
        n_bootstrap: int = 1000,
    ) -> str:
        """Run a mediation analysis (Baron & Kenny approach with Sobel test).

        Args:
            filename: CSV file in workspace
            x_var: Independent variable
            m_var: Mediator variable
            y_var: Dependent variable
            n_bootstrap: Number of bootstrap samples for CI (default 1000)

        Returns:
            Formatted APA mediation results
        """
        df = self._load_csv(filename)

        for v in [x_var, m_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        df_clean = df[[x_var, m_var, y_var]].dropna()
        n = len(df_clean)

        if n < 30:
            return f"Error: Need at least 30 observations for mediation, found {n}"

        X = df_clean[x_var].values
        M = df_clean[m_var].values
        Y = df_clean[y_var].values

        def run_regression(x, y):
            """Simple OLS regression returning coef, se, t, p."""
            x_with_const = np.column_stack([np.ones(len(x)), x])
            try:
                betas = np.linalg.lstsq(x_with_const, y, rcond=None)[0]
                residuals = y - x_with_const @ betas
                rss = np.sum(residuals ** 2)
                df_resid = len(y) - 2
                mse = rss / df_resid
                var_betas = mse * np.linalg.inv(x_with_const.T @ x_with_const)
                se = self._safe_sqrt_diag(var_betas)
                t_stats = betas / se
                p_values = 2 * (1 - stats.t.cdf(np.abs(t_stats), df_resid))
                return {
                    "coef": float(betas[1]),
                    "se": float(se[1]),
                    "t": float(t_stats[1]),
                    "p": float(p_values[1]),
                }
            except Exception:
                return {"coef": 0, "se": 0, "t": 0, "p": 1}

        def run_multiple_regression(x_vars, y):
            """Multiple regression for path b and c'."""
            x_with_const = np.column_stack([np.ones(len(y))] + x_vars)
            try:
                betas = np.linalg.lstsq(x_with_const, y, rcond=None)[0]
                residuals = y - x_with_const @ betas
                rss = np.sum(residuals ** 2)
                df_resid = len(y) - x_with_const.shape[1]
                mse = rss / df_resid
                var_betas = mse * np.linalg.inv(x_with_const.T @ x_with_const)
                se = self._safe_sqrt_diag(var_betas)
                t_stats = betas / se
                p_values = 2 * (1 - stats.t.cdf(np.abs(t_stats), df_resid))
                return [
                    {"coef": float(betas[i]), "se": float(se[i]), "t": float(t_stats[i]), "p": float(p_values[i])}
                    for i in range(1, len(betas))
                ]
            except Exception:
                return [{"coef": 0, "se": 0, "t": 0, "p": 1} for _ in x_vars]

        # Path a: X → M
        path_a = run_regression(X, M)

        # Path c: X → Y (total effect)
        path_c = run_regression(X, Y)

        # Paths b and c': M → Y and X → Y controlling for M
        multiple_results = run_multiple_regression([X, M], Y)
        path_c_prime = multiple_results[0]  # X effect controlling for M
        path_b = multiple_results[1]  # M effect controlling for X

        # Indirect effect
        indirect_effect = path_a["coef"] * path_b["coef"]

        # Sobel test
        se_indirect = np.sqrt(
            path_a["coef"] ** 2 * path_b["se"] ** 2 +
            path_b["coef"] ** 2 * path_a["se"] ** 2
        )
        sobel_z = indirect_effect / se_indirect if se_indirect > 0 else 0
        sobel_p = 2 * (1 - stats.norm.cdf(abs(sobel_z)))

        # Bootstrap CI for indirect effect
        indirect_samples = []
        for _ in range(n_bootstrap):
            idx = np.random.choice(n, n, replace=True)
            X_b, M_b, Y_b = X[idx], M[idx], Y[idx]
            a_b = run_regression(X_b, M_b)["coef"]
            mult_b = run_multiple_regression([X_b, M_b], Y_b)
            b_b = mult_b[1]["coef"] if len(mult_b) > 1 else 0
            indirect_samples.append(a_b * b_b)

        bootstrap_ci_lower = float(np.percentile(indirect_samples, 2.5))
        bootstrap_ci_upper = float(np.percentile(indirect_samples, 97.5))

        # Determine mediation type
        if path_a["p"] < 0.05 and path_b["p"] < 0.05:
            if path_c_prime["p"] >= 0.05:
                mediation_type = "full"
            elif abs(path_c_prime["coef"]) < abs(path_c["coef"]):
                mediation_type = "partial"
            else:
                mediation_type = "none"
        else:
            mediation_type = "none"

        self.ingest.ingest_mediation(
            x_var=x_var,
            m_var=m_var,
            y_var=y_var,
            path_a=path_a,
            path_b=path_b,
            path_c=path_c,
            path_c_prime=path_c_prime,
            indirect_effect=float(indirect_effect),
            n=n,
            indirect_se=float(se_indirect),
            sobel_z=float(sobel_z),
            sobel_p=float(sobel_p),
            bootstrap_ci_lower=bootstrap_ci_lower,
            bootstrap_ci_upper=bootstrap_ci_upper,
            mediation_type=mediation_type,
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)

    def analyze_moderation(
        self,
        filename: str,
        x_var: str,
        w_var: str,
        y_var: str,
    ) -> str:
        """Run a moderation analysis (interaction effect).

        Args:
            filename: CSV file in workspace
            x_var: Independent variable
            w_var: Moderator variable
            y_var: Dependent variable

        Returns:
            Formatted APA moderation results
        """
        df = self._load_csv(filename)

        for v in [x_var, w_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        df_clean = df[[x_var, w_var, y_var]].dropna()
        n = len(df_clean)

        if n < 30:
            return f"Error: Need at least 30 observations for moderation, found {n}"

        X = df_clean[x_var].values
        W = df_clean[w_var].values
        Y = df_clean[y_var].values

        # Center predictors
        X_c = X - X.mean()
        W_c = W - W.mean()
        XW = X_c * W_c  # Interaction term

        # Step 1: Model without interaction
        X_step1 = np.column_stack([np.ones(n), X_c, W_c])
        betas1 = np.linalg.lstsq(X_step1, Y, rcond=None)[0]
        y_pred1 = X_step1 @ betas1
        ss_res1 = np.sum((Y - y_pred1) ** 2)
        ss_tot = np.sum((Y - Y.mean()) ** 2)
        r_squared1 = 1 - ss_res1 / ss_tot

        # Step 2: Model with interaction
        X_step2 = np.column_stack([np.ones(n), X_c, W_c, XW])
        betas2 = np.linalg.lstsq(X_step2, Y, rcond=None)[0]
        y_pred2 = X_step2 @ betas2
        ss_res2 = np.sum((Y - y_pred2) ** 2)
        r_squared2 = 1 - ss_res2 / ss_tot
        r_squared_change = r_squared2 - r_squared1

        # Calculate standard errors and t-values
        df_resid = n - 4
        mse = ss_res2 / df_resid
        try:
            var_betas = mse * np.linalg.inv(X_step2.T @ X_step2)
            se = self._safe_sqrt_diag(var_betas)
        except np.linalg.LinAlgError:
            se = np.zeros(4)

        t_stats = betas2 / se if np.all(se > 0) else np.zeros(4)
        p_values = 2 * (1 - stats.t.cdf(np.abs(t_stats), df_resid))

        main_x = {"coef": float(betas2[1]), "se": float(se[1]), "t": float(t_stats[1]), "p": float(p_values[1])}
        main_w = {"coef": float(betas2[2]), "se": float(se[2]), "t": float(t_stats[2]), "p": float(p_values[2])}
        interaction = {"coef": float(betas2[3]), "se": float(se[3]), "t": float(t_stats[3]), "p": float(p_values[3])}

        # F-change for interaction
        df_num = 1  # One interaction term added
        df_denom = df_resid
        f_change = ((ss_res1 - ss_res2) / df_num) / mse if mse > 0 else 0
        f_change_p = 1 - stats.f.cdf(f_change, df_num, df_denom)

        # Simple slopes at -1SD, mean, +1SD of moderator
        w_sd = W_c.std()
        simple_slopes = []
        for level_name, w_val in [("-1 SD", -w_sd), ("Mean", 0), ("+1 SD", w_sd)]:
            # Slope of X at this level of W: b1 + b3 * W
            slope = betas2[1] + betas2[3] * w_val
            # SE of simple slope
            var_slope = var_betas[1, 1] + 2 * w_val * var_betas[1, 3] + w_val ** 2 * var_betas[3, 3]
            se_slope = np.sqrt(max(0, var_slope))
            t_slope = slope / se_slope if se_slope > 0 else 0
            p_slope = 2 * (1 - stats.t.cdf(abs(t_slope), df_resid))

            simple_slopes.append({
                "level": level_name,
                "slope": float(slope),
                "se": float(se_slope),
                "t": float(t_slope),
                "p": float(p_slope),
            })

        self.ingest.ingest_moderation(
            x_var=x_var,
            w_var=w_var,
            y_var=y_var,
            main_x=main_x,
            main_w=main_w,
            interaction=interaction,
            r_squared=float(r_squared2),
            r_squared_change=float(r_squared_change),
            f_change=float(f_change),
            f_change_p=float(f_change_p),
            n=n,
            simple_slopes=simple_slopes,
        )

        result_id = f"result_{self.ingest.store._result_counter:03d}"
        return self.ingest.format_result(result_id)
