from setuptools import setup

setup(
    name="floom-cli",
    version="0.1.0",
    license="MIT",
    py_modules=["floom", "floom_telemetry"],
    install_requires=[
        "click>=8.0",
        "requests>=2.28",
    ],
    entry_points={
        "console_scripts": [
            "floom=floom:cli",
        ],
    },
    python_requires=">=3.9",
)
