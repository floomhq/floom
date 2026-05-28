"""Figure generation for statistical analyses.

Creates publication-ready charts using matplotlib/seaborn.
Figures are saved to workspace/figures/ directory.
"""

import logging
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend
import matplotlib.pyplot as plt
import seaborn as sns

from opendraft.research import ResearchStore, IngestOps

logger = logging.getLogger(__name__)

# Set publication-ready style
plt.style.use('seaborn-v0_8-whitegrid')
sns.set_context("paper", font_scale=1.2)


class FigureGenerator:
    """Generate publication-ready figures for statistical analyses."""

    def __init__(self, workspace_dir: Path, research_store: ResearchStore):
        self.workspace_dir = workspace_dir
        self.figures_dir = workspace_dir / "figures"
        self.figures_dir.mkdir(exist_ok=True)
        self.ingest = IngestOps(research_store)
        self._figure_counter = 0

    def _next_filename(self, prefix: str) -> Tuple[str, int]:
        """Generate next figure filename and number."""
        self._figure_counter += 1
        filename = f"{prefix}_{self._figure_counter:02d}.png"
        return filename, self._figure_counter

    def _load_csv(self, filename: str) -> pd.DataFrame:
        """Load CSV from workspace."""
        path = self.workspace_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"File not found: {filename}")
        return pd.read_csv(path)

    def scatter_plot(
        self,
        filename: str,
        x_var: str,
        y_var: str,
        hue_var: Optional[str] = None,
        title: Optional[str] = None,
        add_regression: bool = True,
    ) -> str:
        """Create a scatter plot with optional regression line.

        Args:
            filename: CSV file in workspace
            x_var: X-axis variable
            y_var: Y-axis variable
            hue_var: Optional grouping variable for color
            title: Optional custom title
            add_regression: Add regression line (default True)

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        for v in [x_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        fig, ax = plt.subplots(figsize=(8, 6))

        if hue_var and hue_var in df.columns:
            sns.scatterplot(data=df, x=x_var, y=y_var, hue=hue_var, ax=ax, alpha=0.7)
        else:
            sns.scatterplot(data=df, x=x_var, y=y_var, ax=ax, alpha=0.7)

        if add_regression and not hue_var:
            sns.regplot(data=df, x=x_var, y=y_var, ax=ax, scatter=False, color='red')

        ax.set_xlabel(x_var.replace('_', ' ').title())
        ax.set_ylabel(y_var.replace('_', ' ').title())

        fig_title = title or f"Relationship between {x_var.replace('_', ' ')} and {y_var.replace('_', ' ')}"
        ax.set_title(fig_title)

        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("scatter")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        # Register figure
        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Scatter plot showing the relationship between {x_var.replace('_', ' ')} and {y_var.replace('_', ' ')}.",
        )

        return f"Created scatter plot: figures/{fig_filename}"

    def bar_chart(
        self,
        filename: str,
        x_var: str,
        y_var: str,
        title: Optional[str] = None,
        error_bars: bool = True,
    ) -> str:
        """Create a bar chart with error bars.

        Args:
            filename: CSV file in workspace
            x_var: Categorical variable for x-axis
            y_var: Numeric variable for y-axis (will compute mean)
            title: Optional custom title
            error_bars: Show standard error bars (default True)

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        for v in [x_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        fig, ax = plt.subplots(figsize=(8, 6))

        if error_bars:
            sns.barplot(data=df, x=x_var, y=y_var, ax=ax, errorbar='se', capsize=0.1)
        else:
            sns.barplot(data=df, x=x_var, y=y_var, ax=ax, errorbar=None)

        ax.set_xlabel(x_var.replace('_', ' ').title())
        ax.set_ylabel(y_var.replace('_', ' ').title())

        fig_title = title or f"Mean {y_var.replace('_', ' ')} by {x_var.replace('_', ' ')}"
        ax.set_title(fig_title)

        plt.xticks(rotation=45, ha='right')
        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("bar")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Bar chart showing mean {y_var.replace('_', ' ')} across {x_var.replace('_', ' ')} groups. Error bars represent standard error.",
        )

        return f"Created bar chart: figures/{fig_filename}"

    def box_plot(
        self,
        filename: str,
        x_var: str,
        y_var: str,
        title: Optional[str] = None,
    ) -> str:
        """Create a box plot.

        Args:
            filename: CSV file in workspace
            x_var: Categorical grouping variable
            y_var: Numeric variable
            title: Optional custom title

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        for v in [x_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        fig, ax = plt.subplots(figsize=(8, 6))

        sns.boxplot(data=df, x=x_var, y=y_var, ax=ax)

        ax.set_xlabel(x_var.replace('_', ' ').title())
        ax.set_ylabel(y_var.replace('_', ' ').title())

        fig_title = title or f"Distribution of {y_var.replace('_', ' ')} by {x_var.replace('_', ' ')}"
        ax.set_title(fig_title)

        plt.xticks(rotation=45, ha='right')
        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("box")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Box plot showing the distribution of {y_var.replace('_', ' ')} across {x_var.replace('_', ' ')} groups.",
        )

        return f"Created box plot: figures/{fig_filename}"

    def histogram(
        self,
        filename: str,
        variable: str,
        bins: int = 20,
        title: Optional[str] = None,
    ) -> str:
        """Create a histogram with KDE overlay.

        Args:
            filename: CSV file in workspace
            variable: Numeric variable to plot
            bins: Number of bins (default 20)
            title: Optional custom title

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        if variable not in df.columns:
            return f"Error: Variable not found: {variable}"

        fig, ax = plt.subplots(figsize=(8, 6))

        sns.histplot(data=df, x=variable, bins=bins, kde=True, ax=ax)

        ax.set_xlabel(variable.replace('_', ' ').title())
        ax.set_ylabel("Frequency")

        fig_title = title or f"Distribution of {variable.replace('_', ' ')}"
        ax.set_title(fig_title)

        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("hist")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Histogram showing the distribution of {variable.replace('_', ' ')} with kernel density estimate overlay.",
        )

        return f"Created histogram: figures/{fig_filename}"

    def correlation_heatmap(
        self,
        filename: str,
        variables: List[str],
        title: Optional[str] = None,
        annotate: bool = True,
    ) -> str:
        """Create a correlation heatmap.

        Args:
            filename: CSV file in workspace
            variables: List of numeric variables to correlate
            title: Optional custom title
            annotate: Show correlation values (default True)

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        missing = [v for v in variables if v not in df.columns]
        if missing:
            return f"Error: Variables not found: {missing}"

        corr_matrix = df[variables].corr()

        fig, ax = plt.subplots(figsize=(10, 8))

        mask = np.triu(np.ones_like(corr_matrix, dtype=bool), k=1)

        sns.heatmap(
            corr_matrix,
            mask=mask,
            annot=annotate,
            fmt='.2f',
            cmap='RdBu_r',
            center=0,
            square=True,
            linewidths=0.5,
            ax=ax,
            vmin=-1,
            vmax=1,
        )

        fig_title = title or "Correlation Matrix"
        ax.set_title(fig_title)

        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("heatmap")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        var_names = ', '.join(v.replace('_', ' ') for v in variables[:3])
        if len(variables) > 3:
            var_names += f" and {len(variables) - 3} more"

        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Correlation heatmap showing Pearson correlations among {var_names}.",
        )

        return f"Created correlation heatmap: figures/{fig_filename}"

    def line_chart(
        self,
        filename: str,
        x_var: str,
        y_var: str,
        hue_var: Optional[str] = None,
        title: Optional[str] = None,
    ) -> str:
        """Create a line chart (for time series or trends).

        Args:
            filename: CSV file in workspace
            x_var: X-axis variable (often time)
            y_var: Y-axis variable
            hue_var: Optional grouping variable for multiple lines
            title: Optional custom title

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        for v in [x_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        fig, ax = plt.subplots(figsize=(10, 6))

        if hue_var and hue_var in df.columns:
            sns.lineplot(data=df, x=x_var, y=y_var, hue=hue_var, ax=ax, marker='o')
        else:
            sns.lineplot(data=df, x=x_var, y=y_var, ax=ax, marker='o')

        ax.set_xlabel(x_var.replace('_', ' ').title())
        ax.set_ylabel(y_var.replace('_', ' ').title())

        fig_title = title or f"{y_var.replace('_', ' ')} over {x_var.replace('_', ' ')}"
        ax.set_title(fig_title)

        plt.xticks(rotation=45, ha='right')
        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("line")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Line chart showing {y_var.replace('_', ' ')} over {x_var.replace('_', ' ')}.",
        )

        return f"Created line chart: figures/{fig_filename}"

    def violin_plot(
        self,
        filename: str,
        x_var: str,
        y_var: str,
        title: Optional[str] = None,
    ) -> str:
        """Create a violin plot.

        Args:
            filename: CSV file in workspace
            x_var: Categorical grouping variable
            y_var: Numeric variable
            title: Optional custom title

        Returns:
            Confirmation with figure path
        """
        df = self._load_csv(filename)

        for v in [x_var, y_var]:
            if v not in df.columns:
                return f"Error: Variable not found: {v}"

        fig, ax = plt.subplots(figsize=(8, 6))

        sns.violinplot(data=df, x=x_var, y=y_var, ax=ax, inner='box')

        ax.set_xlabel(x_var.replace('_', ' ').title())
        ax.set_ylabel(y_var.replace('_', ' ').title())

        fig_title = title or f"Distribution of {y_var.replace('_', ' ')} by {x_var.replace('_', ' ')}"
        ax.set_title(fig_title)

        plt.xticks(rotation=45, ha='right')
        plt.tight_layout()

        fig_filename, fig_num = self._next_filename("violin")
        fig_path = self.figures_dir / fig_filename
        plt.savefig(fig_path, dpi=300, bbox_inches='tight')
        plt.close(fig)

        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Violin plot showing the distribution of {y_var.replace('_', ' ')} across {x_var.replace('_', ' ')} groups.",
        )

        return f"Created violin plot: figures/{fig_filename}"
