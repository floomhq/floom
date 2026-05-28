"""Ingest operations for structured research results.

Provides handlers for ingest_regression, ingest_ttest, etc. that store
results in ResearchStore and can format them as APA tables/prose.
"""

from typing import Any, Dict, List, Optional

from .store import (
    ResearchStore,
    RegressionResult,
    TTestResult,
    CorrelationResult,
    DescriptivesResult,
    ThemeResult,
    AnovaResult,
    ChiSquareResult,
    # Phase 2b
    LogisticRegressionResult,
    LogisticPredictor,
    NonParametricResult,
    FactorialAnovaResult,
    RepeatedMeasuresResult,
    ReliabilityResult,
    Figure,
    Predictor,
)


class IngestOps:
    """Handlers for ingesting structured research results."""

    def __init__(self, store: ResearchStore):
        self.store = store

    def ingest_regression(
        self,
        type: str,
        dependent_var: str,
        predictors: List[Dict[str, Any]],
        r_squared: float,
        n: int,
        adj_r_squared: Optional[float] = None,
        f_stat: Optional[float] = None,
        f_p: Optional[float] = None,
        model_note: Optional[str] = None,
    ) -> str:
        """Ingest regression analysis results.

        Args:
            type: Regression type (ols, logistic, hierarchical)
            dependent_var: Name of dependent variable
            predictors: List of predictor dicts with keys: name, coef, se, p, beta, t, ci_lower, ci_upper
            r_squared: R-squared value
            n: Sample size
            adj_r_squared: Adjusted R-squared (optional)
            f_stat: F-statistic (optional)
            f_p: p-value for F-statistic (optional)
            model_note: Additional note for table (optional)

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        # Convert predictor dicts to Predictor objects
        predictor_objects = [
            Predictor(
                name=p.get("name", "Unknown"),
                coef=p.get("coef", 0.0),
                se=p.get("se"),
                beta=p.get("beta"),
                t=p.get("t"),
                p=p.get("p"),
                ci_lower=p.get("ci_lower"),
                ci_upper=p.get("ci_upper"),
            )
            for p in predictors
        ]

        result = RegressionResult(
            id=result_id,
            type=type,
            dependent_var=dependent_var,
            predictors=predictor_objects,
            r_squared=r_squared,
            n=n,
            adj_r_squared=adj_r_squared,
            f_stat=f_stat,
            f_p=f_p,
            model_note=model_note,
        )

        self.store.add_result(result)
        return f"Ingested {type} regression '{result_id}': {dependent_var} ~ {', '.join(p.name for p in predictor_objects)}"

    def ingest_ttest(
        self,
        type: str,
        group1: str,
        mean1: float,
        t: float,
        df: float,
        p: float,
        group2: Optional[str] = None,
        mean2: Optional[float] = None,
        sd1: Optional[float] = None,
        sd2: Optional[float] = None,
        cohens_d: Optional[float] = None,
        ci_lower: Optional[float] = None,
        ci_upper: Optional[float] = None,
        test_value: Optional[float] = None,
    ) -> str:
        """Ingest t-test results.

        Args:
            type: Test type (independent, paired, one_sample)
            group1: First group name
            mean1: Mean of first group
            t: t-statistic
            df: Degrees of freedom
            p: p-value
            group2: Second group name (for independent/paired)
            mean2: Mean of second group
            sd1: SD of first group
            sd2: SD of second group
            cohens_d: Cohen's d effect size
            ci_lower: Lower CI bound
            ci_upper: Upper CI bound
            test_value: Test value (for one-sample)

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = TTestResult(
            id=result_id,
            type=type,
            group1=group1,
            mean1=mean1,
            t=t,
            df=df,
            p=p,
            group2=group2,
            mean2=mean2,
            sd1=sd1,
            sd2=sd2,
            cohens_d=cohens_d,
            ci_lower=ci_lower,
            ci_upper=ci_upper,
            test_value=test_value,
        )

        self.store.add_result(result)

        if type == "one_sample":
            return f"Ingested one-sample t-test '{result_id}': {group1} vs {test_value}"
        else:
            return f"Ingested {type} t-test '{result_id}': {group1} vs {group2}"

    def ingest_correlation(
        self,
        variables: List[str],
        matrix: List[List[float]],
        n: int,
        method: str = "pearson",
        p_values: Optional[List[List[float]]] = None,
    ) -> str:
        """Ingest correlation matrix.

        Args:
            variables: List of variable names
            matrix: Correlation matrix (list of lists)
            n: Sample size
            method: Correlation method (pearson, spearman)
            p_values: Matrix of p-values (optional)

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = CorrelationResult(
            id=result_id,
            variables=variables,
            matrix=matrix,
            n=n,
            method=method,
            p_values=p_values,
        )

        self.store.add_result(result)
        return f"Ingested {method} correlation matrix '{result_id}': {len(variables)} variables"

    def ingest_descriptives(
        self,
        variables: List[Dict[str, Any]],
        by_group: Optional[str] = None,
    ) -> str:
        """Ingest descriptive statistics.

        Args:
            variables: List of dicts with keys: name, mean, sd, min, max, n, skewness, kurtosis
            by_group: Grouping variable name (optional)

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = DescriptivesResult(
            id=result_id,
            variables=variables,
            by_group=by_group,
        )

        self.store.add_result(result)
        var_names = [v.get("name", "Unknown") for v in variables]
        return f"Ingested descriptives '{result_id}': {', '.join(var_names)}"

    def ingest_themes(
        self,
        themes: List[Dict[str, Any]],
        total_participants: int,
        method: str = "thematic",
    ) -> str:
        """Ingest thematic analysis results.

        Args:
            themes: List of theme dicts with keys: name, description, frequency, quotes
            total_participants: Total number of participants
            method: Analysis method (thematic, content, grounded)

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = ThemeResult(
            id=result_id,
            method=method,
            themes=themes,
            total_participants=total_participants,
        )

        self.store.add_result(result)
        theme_names = [t.get("name", "Unknown") for t in themes]
        return f"Ingested {method} analysis '{result_id}': {len(themes)} themes ({', '.join(theme_names)})"

    def ingest_anova(
        self,
        dependent_var: str,
        group_var: str,
        groups: List[Dict[str, Any]],
        f_stat: float,
        df_between: int,
        df_within: int,
        p: float,
        eta_squared: Optional[float] = None,
        post_hoc: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Ingest one-way ANOVA results.

        Args:
            dependent_var: Dependent variable name
            group_var: Grouping variable name
            groups: List of group dicts with keys: name, mean, sd, n
            f_stat: F-statistic
            df_between: Degrees of freedom between groups
            df_within: Degrees of freedom within groups
            p: p-value
            eta_squared: Effect size (optional)
            post_hoc: Post-hoc comparisons (optional), list of dicts with: group1, group2, diff, p

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = AnovaResult(
            id=result_id,
            dependent_var=dependent_var,
            group_var=group_var,
            groups=groups,
            f_stat=f_stat,
            df_between=df_between,
            df_within=df_within,
            p=p,
            eta_squared=eta_squared,
            post_hoc=post_hoc,
        )

        self.store.add_result(result)
        group_names = [g.get("name", "Unknown") for g in groups]
        return f"Ingested ANOVA '{result_id}': {dependent_var} by {group_var} ({', '.join(group_names)})"

    def ingest_chisquare(
        self,
        var1: str,
        var2: str,
        contingency_table: List[List[int]],
        row_labels: List[str],
        col_labels: List[str],
        chi_square: float,
        df: int,
        p: float,
        n: int,
        cramers_v: Optional[float] = None,
    ) -> str:
        """Ingest chi-square test results.

        Args:
            var1: Row variable name
            var2: Column variable name
            contingency_table: 2D list of counts
            row_labels: Labels for rows
            col_labels: Labels for columns
            chi_square: Chi-square statistic
            df: Degrees of freedom
            p: p-value
            n: Total sample size
            cramers_v: Cramer's V effect size (optional)

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = ChiSquareResult(
            id=result_id,
            var1=var1,
            var2=var2,
            contingency_table=contingency_table,
            row_labels=row_labels,
            col_labels=col_labels,
            chi_square=chi_square,
            df=df,
            p=p,
            n=n,
            cramers_v=cramers_v,
        )

        self.store.add_result(result)
        return f"Ingested chi-square '{result_id}': {var1} × {var2}"

    # =========================================================================
    # PHASE 2b: EXTENDED ANALYSIS INGESTION
    # =========================================================================

    def ingest_logistic_regression(
        self,
        dependent_var: str,
        predictors: List[Dict[str, Any]],
        n: int,
        n_events: int,
        pseudo_r_squared: Optional[float] = None,
        log_likelihood: Optional[float] = None,
        aic: Optional[float] = None,
        chi_square: Optional[float] = None,
        chi_p: Optional[float] = None,
    ) -> str:
        """Ingest logistic regression results.

        Args:
            dependent_var: Binary outcome variable name
            predictors: List of predictor dicts with: name, coef, se, z, p, odds_ratio, ci_lower, ci_upper
            n: Total sample size
            n_events: Number of positive outcomes (1s)
            pseudo_r_squared: McFadden's R-squared
            log_likelihood: Log-likelihood of the model
            aic: Akaike Information Criterion
            chi_square: Model chi-square
            chi_p: p-value for model chi-square

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        predictor_objects = [
            LogisticPredictor(
                name=p.get("name", "Unknown"),
                coef=p.get("coef", 0.0),
                se=p.get("se"),
                z=p.get("z"),
                p=p.get("p"),
                odds_ratio=p.get("odds_ratio"),
                ci_lower=p.get("ci_lower"),
                ci_upper=p.get("ci_upper"),
            )
            for p in predictors
        ]

        result = LogisticRegressionResult(
            id=result_id,
            dependent_var=dependent_var,
            predictors=predictor_objects,
            n=n,
            n_events=n_events,
            pseudo_r_squared=pseudo_r_squared,
            log_likelihood=log_likelihood,
            aic=aic,
            chi_square=chi_square,
            chi_p=chi_p,
        )

        self.store.add_result(result)
        pred_names = [p.name for p in predictor_objects]
        return f"Ingested logistic regression '{result_id}': {dependent_var} ~ {', '.join(pred_names)}"

    def ingest_nonparametric(
        self,
        test_type: str,
        variable: str,
        statistic: float,
        p: float,
        n: int,
        groups: Optional[List[Dict[str, Any]]] = None,
        effect_size: Optional[float] = None,
        effect_name: Optional[str] = None,
    ) -> str:
        """Ingest non-parametric test results.

        Args:
            test_type: 'mann_whitney', 'kruskal_wallis', or 'wilcoxon'
            variable: Variable being tested
            statistic: Test statistic (U, H, or W)
            p: p-value
            n: Sample size
            groups: List of group dicts with: name, n, median, mean_rank
            effect_size: Effect size (r for Mann-Whitney/Wilcoxon, epsilon² for Kruskal-Wallis)
            effect_name: Name of effect size ('r' or 'ε²')

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = NonParametricResult(
            id=result_id,
            test_type=test_type,
            variable=variable,
            groups=groups,
            statistic=statistic,
            p=p,
            effect_size=effect_size,
            effect_name=effect_name,
            n=n,
        )

        self.store.add_result(result)
        test_names = {"mann_whitney": "Mann-Whitney", "kruskal_wallis": "Kruskal-Wallis", "wilcoxon": "Wilcoxon"}
        return f"Ingested {test_names.get(test_type, test_type)} '{result_id}': {variable}"

    def ingest_factorial_anova(
        self,
        dependent_var: str,
        factor1: str,
        factor2: str,
        factor1_levels: List[str],
        factor2_levels: List[str],
        main_effect1: Dict[str, Any],
        main_effect2: Dict[str, Any],
        interaction: Dict[str, Any],
        cell_means: List[List[Dict[str, Any]]],
        n: int,
        df_error: int,
    ) -> str:
        """Ingest factorial (two-way) ANOVA results.

        Args:
            dependent_var: Dependent variable name
            factor1: First factor name
            factor2: Second factor name
            factor1_levels: Levels of factor 1
            factor2_levels: Levels of factor 2
            main_effect1: Dict with f_stat, df, p, eta_squared
            main_effect2: Dict with f_stat, df, p, eta_squared
            interaction: Dict with f_stat, df, p, eta_squared
            cell_means: 2D list of cell statistics
            n: Total sample size
            df_error: Error degrees of freedom

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = FactorialAnovaResult(
            id=result_id,
            dependent_var=dependent_var,
            factor1=factor1,
            factor2=factor2,
            factor1_levels=factor1_levels,
            factor2_levels=factor2_levels,
            main_effect1=main_effect1,
            main_effect2=main_effect2,
            interaction=interaction,
            cell_means=cell_means,
            n=n,
            df_error=df_error,
        )

        self.store.add_result(result)
        return f"Ingested factorial ANOVA '{result_id}': {dependent_var} ~ {factor1} × {factor2}"

    def ingest_repeated_measures(
        self,
        dependent_var: str,
        within_factor: str,
        levels: List[str],
        level_means: List[Dict[str, Any]],
        f_stat: float,
        df_effect: float,
        df_error: float,
        p: float,
        n: int,
        eta_squared: Optional[float] = None,
        sphericity_violated: bool = False,
        epsilon: Optional[float] = None,
        mauchly_p: Optional[float] = None,
    ) -> str:
        """Ingest repeated measures ANOVA results.

        Args:
            dependent_var: Dependent variable name
            within_factor: Within-subjects factor name
            levels: Factor level names
            level_means: List of dicts with name, mean, sd, n
            f_stat: F-statistic
            df_effect: Effect degrees of freedom (may be corrected)
            df_error: Error degrees of freedom
            p: p-value
            n: Sample size
            eta_squared: Partial eta-squared
            sphericity_violated: Whether sphericity was violated
            epsilon: Greenhouse-Geisser epsilon
            mauchly_p: Mauchly's test p-value

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = RepeatedMeasuresResult(
            id=result_id,
            dependent_var=dependent_var,
            within_factor=within_factor,
            levels=levels,
            level_means=level_means,
            f_stat=f_stat,
            df_effect=df_effect,
            df_error=df_error,
            p=p,
            eta_squared=eta_squared,
            sphericity_violated=sphericity_violated,
            epsilon=epsilon,
            mauchly_p=mauchly_p,
            n=n,
        )

        self.store.add_result(result)
        return f"Ingested repeated measures ANOVA '{result_id}': {dependent_var} ~ {within_factor} ({len(levels)} levels)"

    def ingest_reliability(
        self,
        scale_name: str,
        items: List[str],
        cronbachs_alpha: float,
        n_items: int,
        n_cases: int,
        item_stats: Optional[List[Dict[str, Any]]] = None,
        mean_inter_item_r: Optional[float] = None,
    ) -> str:
        """Ingest reliability analysis results.

        Args:
            scale_name: Name of the scale/measure
            items: List of item names
            cronbachs_alpha: Cronbach's alpha value
            n_items: Number of items
            n_cases: Number of cases/participants
            item_stats: List of dicts with name, item_total_r, alpha_if_deleted
            mean_inter_item_r: Mean inter-item correlation

        Returns:
            Confirmation message with result ID
        """
        result_id = self.store.next_result_id()

        result = ReliabilityResult(
            id=result_id,
            scale_name=scale_name,
            items=items,
            cronbachs_alpha=cronbachs_alpha,
            n_items=n_items,
            n_cases=n_cases,
            item_stats=item_stats,
            mean_inter_item_r=mean_inter_item_r,
        )

        self.store.add_result(result)
        return f"Ingested reliability '{result_id}': {scale_name} (α = {cronbachs_alpha:.2f}, {n_items} items)"

    # =========================================================================
    # PHASE 3: ADVANCED ANALYSIS INGESTION
    # =========================================================================

    def ingest_mixed_model(
        self,
        dependent_var: str,
        fixed_effects: List[Dict[str, Any]],
        random_effects: List[Dict[str, Any]],
        group_var: str,
        n_obs: int,
        n_groups: int,
        log_likelihood: Optional[float] = None,
        aic: Optional[float] = None,
        bic: Optional[float] = None,
        icc: Optional[float] = None,
    ) -> str:
        """Ingest mixed (multilevel) model results.

        Args:
            dependent_var: Dependent variable name
            fixed_effects: List of dicts with name, coef, se, z, p, ci_lower, ci_upper
            random_effects: List of dicts with group, variance, sd
            group_var: Grouping variable name
            n_obs: Number of observations
            n_groups: Number of groups
            log_likelihood: Log-likelihood of the model
            aic: Akaike Information Criterion
            bic: Bayesian Information Criterion
            icc: Intraclass correlation coefficient

        Returns:
            Confirmation message with result ID
        """
        from opendraft.research.store import MixedModelResult

        result_id = self.store.next_result_id()

        result = MixedModelResult(
            id=result_id,
            dependent_var=dependent_var,
            fixed_effects=fixed_effects,
            random_effects=random_effects,
            group_var=group_var,
            n_obs=n_obs,
            n_groups=n_groups,
            log_likelihood=log_likelihood,
            aic=aic,
            bic=bic,
            icc=icc,
        )

        self.store.add_result(result)
        return f"Ingested mixed model '{result_id}': {dependent_var} ~ ... | {group_var}"

    def ingest_manova(
        self,
        dependent_vars: List[str],
        group_var: str,
        groups: List[str],
        pillais_trace: float,
        wilks_lambda: float,
        f_stat: float,
        df1: int,
        df2: int,
        p: float,
        n: int,
        univariate_results: List[Dict[str, Any]],
    ) -> str:
        """Ingest MANOVA results.

        Args:
            dependent_vars: List of dependent variable names
            group_var: Grouping variable name
            groups: List of group names
            pillais_trace: Pillai's Trace statistic
            wilks_lambda: Wilks' Lambda statistic
            f_stat: F-statistic for multivariate test
            df1: Numerator degrees of freedom
            df2: Denominator degrees of freedom
            p: p-value
            n: Sample size
            univariate_results: List of univariate ANOVA results

        Returns:
            Confirmation message with result ID
        """
        from opendraft.research.store import ManovaResult

        result_id = self.store.next_result_id()

        result = ManovaResult(
            id=result_id,
            dependent_vars=dependent_vars,
            group_var=group_var,
            groups=groups,
            pillais_trace=pillais_trace,
            wilks_lambda=wilks_lambda,
            f_stat=f_stat,
            df1=df1,
            df2=df2,
            p=p,
            n=n,
            univariate_results=univariate_results,
        )

        self.store.add_result(result)
        dv_names = ", ".join(dependent_vars[:3]) + ("..." if len(dependent_vars) > 3 else "")
        return f"Ingested MANOVA '{result_id}': {group_var} → [{dv_names}]"

    def ingest_mediation(
        self,
        x_var: str,
        m_var: str,
        y_var: str,
        path_a: Dict[str, Any],
        path_b: Dict[str, Any],
        path_c: Dict[str, Any],
        path_c_prime: Dict[str, Any],
        indirect_effect: float,
        n: int,
        indirect_se: Optional[float] = None,
        sobel_z: Optional[float] = None,
        sobel_p: Optional[float] = None,
        bootstrap_ci_lower: Optional[float] = None,
        bootstrap_ci_upper: Optional[float] = None,
        mediation_type: str = "",
    ) -> str:
        """Ingest mediation analysis results.

        Args:
            x_var: Independent variable
            m_var: Mediator variable
            y_var: Dependent variable
            path_a: Path a (X → M): dict with coef, se, t, p
            path_b: Path b (M → Y): dict with coef, se, t, p
            path_c: Total effect (X → Y): dict with coef, se, t, p
            path_c_prime: Direct effect (X → Y controlling M): dict with coef, se, t, p
            indirect_effect: Indirect effect (a × b)
            n: Sample size
            indirect_se: Standard error of indirect effect
            sobel_z: Sobel test z-statistic
            sobel_p: Sobel test p-value
            bootstrap_ci_lower: Bootstrap CI lower bound
            bootstrap_ci_upper: Bootstrap CI upper bound
            mediation_type: "full", "partial", or "none"

        Returns:
            Confirmation message with result ID
        """
        from opendraft.research.store import MediationResult

        result_id = self.store.next_result_id()

        result = MediationResult(
            id=result_id,
            x_var=x_var,
            m_var=m_var,
            y_var=y_var,
            path_a=path_a,
            path_b=path_b,
            path_c=path_c,
            path_c_prime=path_c_prime,
            indirect_effect=indirect_effect,
            indirect_se=indirect_se,
            sobel_z=sobel_z,
            sobel_p=sobel_p,
            bootstrap_ci_lower=bootstrap_ci_lower,
            bootstrap_ci_upper=bootstrap_ci_upper,
            n=n,
            mediation_type=mediation_type,
        )

        self.store.add_result(result)
        return f"Ingested mediation '{result_id}': {x_var} → {m_var} → {y_var}"

    def ingest_moderation(
        self,
        x_var: str,
        w_var: str,
        y_var: str,
        main_x: Dict[str, Any],
        main_w: Dict[str, Any],
        interaction: Dict[str, Any],
        r_squared: float,
        r_squared_change: float,
        f_change: float,
        f_change_p: float,
        n: int,
        simple_slopes: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Ingest moderation analysis results.

        Args:
            x_var: Independent variable
            w_var: Moderator variable
            y_var: Dependent variable
            main_x: Main effect of X: dict with coef, se, t, p
            main_w: Main effect of W: dict with coef, se, t, p
            interaction: Interaction (X × W): dict with coef, se, t, p
            r_squared: Total R² of the model
            r_squared_change: R² change due to interaction
            f_change: F-change for interaction
            f_change_p: p-value for F-change
            n: Sample size
            simple_slopes: List of simple slope analyses

        Returns:
            Confirmation message with result ID
        """
        from opendraft.research.store import ModerationResult

        result_id = self.store.next_result_id()

        result = ModerationResult(
            id=result_id,
            x_var=x_var,
            w_var=w_var,
            y_var=y_var,
            main_x=main_x,
            main_w=main_w,
            interaction=interaction,
            r_squared=r_squared,
            r_squared_change=r_squared_change,
            f_change=f_change,
            f_change_p=f_change_p,
            n=n,
            simple_slopes=simple_slopes,
        )

        self.store.add_result(result)
        return f"Ingested moderation '{result_id}': {x_var} × {w_var} → {y_var}"

    def ingest_figure(
        self,
        filename: str,
        number: int,
        title: str,
        caption: str,
        note: Optional[str] = None,
    ) -> str:
        """Register a figure for inclusion in the paper.

        Args:
            filename: Filename in workspace/figures/
            number: Figure number (1, 2, 3, ...)
            title: Figure title
            caption: Detailed caption
            note: Additional notes (e.g., "Error bars = 95% CI")

        Returns:
            Confirmation message with figure ID
        """
        figure_id = self.store.next_figure_id()

        figure = Figure(
            id=figure_id,
            filename=filename,
            number=number,
            title=title,
            caption=caption,
            note=note,
        )

        self.store.add_figure(figure)
        return f"Registered figure '{figure_id}': Figure {number} - {title}"

    def format_result(
        self,
        result_id: str,
        table_number: Optional[int] = None,
    ) -> str:
        """Format a specific result as APA table + prose.

        Args:
            result_id: ID of the result to format
            table_number: Table number to use (optional, defaults to result index + 1)

        Returns:
            Formatted APA table and prose
        """
        result = self.store.get_result(result_id)
        if result is None:
            return f"Error: Result '{result_id}' not found"

        # Determine table number
        if table_number is None:
            # Find index of this result
            for i, r in enumerate(self.store.results):
                if r.id == result_id:
                    table_number = i + 1
                    break
            else:
                table_number = 1

        table = result.to_apa_table(table_number)
        prose = result.to_apa_prose()

        return f"{table}\n\n---\n\n{prose}"

    def format_figure(self, figure_id: str) -> str:
        """Format a figure caption.

        Args:
            figure_id: ID of the figure to format

        Returns:
            Formatted APA figure caption
        """
        figure = self.store.get_figure(figure_id)
        if figure is None:
            return f"Error: Figure '{figure_id}' not found"

        return figure.to_apa_format()

    def list_results(self) -> str:
        """List all ingested results.

        Returns:
            Summary of all results
        """
        results = self.store.list_results()
        if not results:
            return "No results ingested yet."

        lines = ["Ingested results:"]
        for r in results:
            line = f"  - {r['id']} ({r['type']})"
            if "dependent_var" in r:
                line += f": {r['dependent_var']}"
            elif "n_variables" in r:
                line += f": {r['n_variables']} variables"
            elif "n_themes" in r:
                line += f": {r['n_themes']} themes"
            lines.append(line)

        return "\n".join(lines)

    def list_figures(self) -> str:
        """List all registered figures.

        Returns:
            Summary of all figures
        """
        figures = self.store.list_figures()
        if not figures:
            return "No figures registered yet."

        lines = ["Registered figures:"]
        for f in figures:
            lines.append(f"  - {f['id']}: Figure {f['number']} - {f['title']}")

        return "\n".join(lines)

    def generate_results_section(
        self,
        include_tables: bool = True,
        include_figures: bool = True,
    ) -> str:
        """Generate a complete Results section from all ingested data.

        Args:
            include_tables: Whether to include tables
            include_figures: Whether to include figure references

        Returns:
            Complete Results section in markdown
        """
        if not self.store.results and not self.store.figures:
            return "No results or figures to include in Results section."

        sections = []

        # Group results by type for logical ordering
        quant_results = []
        qual_results = []

        for result in self.store.results:
            if isinstance(result, ThemeResult):
                qual_results.append(result)
            else:
                quant_results.append(result)

        # Quantitative results first
        if quant_results:
            sections.append("## Quantitative Results\n")
            for i, result in enumerate(quant_results, 1):
                if include_tables:
                    sections.append(result.to_apa_table(i))
                    sections.append("")
                sections.append(result.to_apa_prose())
                sections.append("")

        # Qualitative results
        if qual_results:
            sections.append("## Qualitative Results\n")
            table_offset = len(quant_results) if include_tables else 0
            for i, result in enumerate(qual_results, table_offset + 1):
                if include_tables:
                    sections.append(result.to_apa_table(i))
                    sections.append("")
                sections.append(result.to_apa_prose())
                sections.append("")

        # Figures
        if include_figures and self.store.figures:
            sections.append("## Figures\n")
            for figure in self.store.figures:
                sections.append(figure.to_apa_format())
                sections.append("")

        return "\n".join(sections)
